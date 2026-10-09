import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { beforeAll, afterEach, expect, it } from 'vitest';
import { JudgmentProcessAdapter } from '../src/integrations/judgment-process.js';
import { createDecisionRuntime } from '../src/runtime-core.js';
import { selectJudgmentAdapter } from '../src/integrations/judgment-registry.js';
import { defaultProjectConfig } from '../src/project-config.js';

const exec = promisify(execFile);
let inferLocalJudgment, validateEndpoint, mockJudgment, mapReferenceJudgment;
const servers = [], directories = [];
const task = { data_classification: 'engineering_non_sensitive', task_id: 'local', attempt_id: 'a1', summary: 'Refactor validation', flags: {} };
const wire = { schema_version: '1', task, choices: { executors: ['primary', 'replan'], model_tiers: ['cheap','balanced','strong','max'],
  reasoning_efforts: ['minimal','low','medium','high'], context_budgets: ['tiny','small','medium','large'],
  test_depths: ['none','targeted','standard','full'], review_depths: ['none','targeted','standard','full'], integration_strategies: ['direct','isolated','staged','replan'] } };
const valid = () => mapReferenceJudgment(wire, mockJudgment());
const envelope = raw => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(raw) } }] });
const config = endpoint => ({ version: '1', provider_id: 'local-chat', executors: ['primary','replan'], executable: process.execPath,
  cli_entrypoint: resolve('examples/judgment/local-http-bridge.mjs'), args: [endpoint, 'fixture-model'] });
const runtime = (endpoint, extra = {}) => createDecisionRuntime(selectJudgmentAdapter('process')(config(endpoint), ['primary','replan']),
  { executors: { primary: null, replan: null }, ...extra });
async function fixture(handler = (_req, res) => res.end(JSON.stringify(envelope(valid()))), host = '127.0.0.1') {
  const calls = [];
  let arrived;
  const firstCall = new Promise(done => { arrived = done; });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) }); arrived();
    res.setHeader('Content-Type', 'application/json'); handler(req, res);
  });
  servers.push(server);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, host, done); });
  return { endpoint: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}/v1/chat/completions`, calls, firstCall };
}
beforeAll(async () => {
  await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  ({ inferLocalJudgment, validateEndpoint } = await import('../examples/judgment/local-http-bridge.mjs'));
  ({ mockJudgment, mapReferenceJudgment } = await import('../examples/judgment/reference-bridge.mjs'));
}, 30000);
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
it('uses one structured POST through the empty-environment process boundary and preserves values', async () => {
  const response = valid(); response.decisions.executor.probabilities = { primary: 0.8, replan: 0.2 };
  const f = await fixture((_req,res) => res.end(JSON.stringify(envelope(response))));
  const oldProxy = process.env.HTTP_PROXY, oldSecret = process.env.TASKSTANCE_LOCAL_SECRET;
  process.env.HTTP_PROXY = 'http://192.0.2.1:9'; process.env.TASKSTANCE_LOCAL_SECRET = 'SECRET_SENTINEL';
  let decision;
  try { decision = await runtime(f.endpoint).decider.decide(task); }
  finally {
    if (oldProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldProxy;
    if (oldSecret === undefined) delete process.env.TASKSTANCE_LOCAL_SECRET; else process.env.TASKSTANCE_LOCAL_SECRET = oldSecret;
  }
  expect(decision.source).toBe('provider+policy');
  expect(decision.judgment.decisions).toEqual(response.decisions);
  expect(f.calls).toHaveLength(1);
  const call = f.calls[0];
  expect(call).toMatchObject({ method: 'POST', url: '/v1/chat/completions' });
  expect(call.headers).not.toHaveProperty('authorization');
  expect(call.body).toMatchObject({ model: 'fixture-model', stream: false, response_format: { type: 'json_schema', json_schema: { strict: true } } });
  expect(JSON.parse(call.body.messages[1].content)).toEqual(wire);
  expect(JSON.stringify(call)).not.toMatch(/SECRET_SENTINEL|cli_entrypoint|provider_id|repo_contents/);
});
it.each(['prose','fenced','truncated','refusal','tools','multiple','missing-confidence','bad-choice','bad-probability','duplicate','extra'])
  ('rejects %s output with conservative fallback and one request', async mode => {
    const raw = valid(); let output = envelope(raw);
    if (mode === 'prose') output.choices[0].message.content = 'Here is my advice';
    if (mode === 'fenced') output.choices[0].message.content = '```json\n' + JSON.stringify(raw) + '\n```';
    if (mode === 'truncated') output.choices[0].finish_reason = 'length';
    if (mode === 'refusal') output.choices[0].message.refusal = 'PRIVATE_SENTINEL';
    if (mode === 'tools') output.choices[0].message.tool_calls = [];
    if (mode === 'multiple') output.choices.push(output.choices[0]);
    if (mode === 'missing-confidence') { delete raw.decisions.executor.confidence; output = envelope(raw); }
    if (mode === 'bad-choice') { raw.decisions.executor.selected = 'unknown'; output = envelope(raw); }
    if (mode === 'bad-probability') { raw.decisions.executor.probabilities = { unknown: 0.9 }; output = envelope(raw); }
    if (mode === 'duplicate') output.choices[0].message.content = '{"schema_version":"1","available":true,"available":false}';
    if (mode === 'extra') { raw.explanation = 'PRIVATE_SENTINEL'; output = envelope(raw); }
    const f = await fixture((_req,res) => res.end(JSON.stringify(output)));
    const decision = await runtime(f.endpoint).decider.decide(task);
    expect(decision).toMatchObject({ source: 'fallback', profile: { executor: 'replan' } });
    expect(JSON.stringify(decision)).not.toContain('PRIVATE_SENTINEL'); expect(f.calls).toHaveLength(1);
  });
it('preserves missing decisions and low confidence without fabricating or calibrating them', async () => {
  const raw = valid(); delete raw.decisions.review_depth; raw.decisions.executor.confidence = 0.2;
  const f = await fixture((_req,res) => res.end(JSON.stringify(envelope(raw))));
  const result = await runtime(f.endpoint).decider.decide(task);
  expect(result.profile.executor).toBe('replan');
  expect(result.judgment.decisions.executor.confidence).toBe(0.2);
  expect(result.judgment.decisions).not.toHaveProperty('review_depth');
});
it.each(['redirect','error','oversized','invalid-utf8','compressed'])('fails closed for HTTP %s without retry', async mode => {
  const f = await fixture((_req,res) => {
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', 'http://192.0.2.1:9/'); }
    if (mode === 'error') res.statusCode = 400;
    if (mode === 'compressed') res.setHeader('Content-Encoding', 'gzip');
    res.end(mode === 'oversized' ? 'x'.repeat(262145) : mode === 'invalid-utf8' ? Buffer.from([0xff]) : '{}');
  });
  expect((await runtime(f.endpoint).decider.decide(task)).source).toBe('fallback');
  expect(f.calls).toHaveLength(1);
});
it('fails conservatively when the server is unavailable', async () => {
  const f = await fixture(); const server = servers.pop(); await new Promise(done => server.close(done));
  expect((await runtime(f.endpoint).decider.decide(task)).source).toBe('fallback'); expect(f.calls).toHaveLength(0);
});
it('honors parent timeout with one bounded request', async () => {
  const f = await fixture(() => {});
  expect((await runtime(f.endpoint, { providerTimeoutMs: 2000 }).decider.decide(task)).source).toBe('fallback');
  expect(f.calls).toHaveLength(1);
}, 10000);
it('cancels both direct HTTP and the existing process adapter', async () => {
  for (const direct of [true, false]) {
    const f = await fixture(() => {}); const controller = new AbortController();
    const pending = (direct ? inferLocalJudgment(wire, { endpoint: f.endpoint, model: 'fixture-model' }, controller.signal) :
      new JudgmentProcessAdapter(config(f.endpoint)).decide(task, controller.signal)).catch(error => error);
    await f.firstCall; controller.abort(); expect(await pending).toBeInstanceOf(Error); expect(f.calls).toHaveLength(1);
  }
});
it('pre-cancellation and oversized requests make zero HTTP calls', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  await expect(inferLocalJudgment(wire, { endpoint: f.endpoint, model: 'fixture' }, controller.signal)).rejects.toThrow();
  const oversized = structuredClone(wire);
  oversized.task.flags = Object.fromEntries(Array.from({length: 10000}, (_, i) => ['flag'+i, true]));
  await expect(inferLocalJudgment(oversized, {endpoint: f.endpoint, model: 'fixture'})).rejects.toThrow('limit');
  expect(f.calls).toHaveLength(0);
});
it.each(['http://localhost:1234/v1/chat/completions','http://127.1:1234/v1/chat/completions',
  'http://2130706433:1234/v1/chat/completions','http://127.0.0.2:1234/v1/chat/completions',
  'https://127.0.0.1:1234/v1/chat/completions','http://user:pass@127.0.0.1:1234/v1/chat/completions',
  'http://127.0.0.1:65536/v1/chat/completions','http://127.0.0.1:0/v1/chat/completions',
  'http://127.0.0.1:1234/v1/chat/completions?key=x','http://127.0.0.1:1234/v1/chat/completions#x',
  'http://127.0.0.1:1234/x/../v1/chat/completions','http://[::ffff:127.0.0.1]:1234/v1/chat/completions',
  'http://example.com:1234/v1/chat/completions'])('rejects endpoint %s before connecting', endpoint => {
  expect(() => validateEndpoint(endpoint)).toThrow();
});
it('supports literal IPv6 loopback', async () => {
  const f = await fixture(undefined, '::1');
  expect(await inferLocalJudgment(wire, { endpoint: f.endpoint, model: 'fixture' })).toEqual(valid());
});
it.each(['', ' ', undefined, 'x'.repeat(129), 'bad\nmodel'])('requires an explicit bounded model identifier', async model => {
  const f = await fixture(); await expect(inferLocalJudgment(wire, { endpoint: f.endpoint, model })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it('retains deterministic security floors and skips inference for docs-only tasks', async () => {
  const f = await fixture();
  const result = await runtime(f.endpoint).decider.decide({ ...task, flags: { security_critical: true } });
  expect(result.profile).toMatchObject({ model_tier: 'strong', test_depth: 'full', review_depth: 'full', parallel_safe: false, integration_strategy: 'staged' });
  expect((await runtime(f.endpoint).decider.decide({ ...task, flags: { docs_only: true } })).source).toBe('deterministic');
  expect(f.calls).toHaveLength(1);
});
it('offline CLI makes zero HTTP calls; explicit opt-in uses the same CLI selection', async () => {
  const f = await fixture(); const dir = await mkdtemp(join(tmpdir(), 'taskstance-local-')); directories.push(dir);
  const project = join(dir,'project.json'), judgment = join(dir,'judgment.json'), taskPath = join(dir,'task.json');
  await writeFile(project, JSON.stringify(defaultProjectConfig)); await writeFile(judgment, JSON.stringify(config(f.endpoint)));
  await writeFile(taskPath, JSON.stringify(task));
  const args = [resolve('dist/cli.js'), 'plan', '--config', project, '--task', taskPath];
  expect(JSON.parse((await exec(process.execPath, args)).stdout).decision_source).toBe('fallback'); expect(f.calls).toHaveLength(0);
  expect(JSON.parse((await exec(process.execPath, [...args, '--judgment','process','--judgment-config',judgment])).stdout).decision_source).toBe('provider+policy');
  expect(f.calls).toHaveLength(1);
});
it('applies the destructive floor to valid local advice', async () => {
  const f = await fixture();
  const result = await runtime(f.endpoint).decider.decide({ ...task, flags: { destructive: true } });
  expect(result.source).toBe('provider+policy');
  expect(result.profile).toMatchObject({ reasoning_effort: 'high', test_depth: 'full', review_depth: 'full', parallel_safe: false, integration_strategy: 'staged' });
  expect(f.calls).toHaveLength(1);
});
it('closes the HTTP connection on cancellation', async () => {
  let disconnected;
  const closed = new Promise(done => { disconnected = done; });
  const f = await fixture((_req,res) => res.once('close', disconnected));
  const controller = new AbortController();
  const pending = new JudgmentProcessAdapter(config(f.endpoint)).decide(task, controller.signal).catch(error => error);
  await f.firstCall; controller.abort(); expect(await pending).toBeInstanceOf(Error);
  await closed; expect(f.calls).toHaveLength(1);
});
it.each(['malformed', 'oversized'])('bounds and sanitizes %s process input without HTTP', async mode => {
  const { spawn } = await import('node:child_process');
  const f = await fixture();
  const output = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [config(f.endpoint).cli_entrypoint, ...config(f.endpoint).args], { env: {}, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {}); child.on('error', reject); child.on('close', code => done({stdout,stderr,code}));
    child.stdin.end(mode === 'malformed' ? 'SECRET_SENTINEL{' : 'SECRET_SENTINEL'.repeat(6000));
  });
  expect(output).toEqual({ stdout: '{"schema_version":"1","available":false,"unavailable_reason_code":"INVALID_RESPONSE"}\n', stderr: '', code: 0 });
  expect(f.calls).toHaveLength(0);
});
