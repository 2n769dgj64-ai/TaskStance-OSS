import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
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
let inferSystemOneJudgment, validateEndpoint, mapSystemOneJudgment, systemOneRequest;
const servers = [], directories = [];
const task = { data_classification: 'engineering_non_sensitive', task_id: 'local', attempt_id: 'a1', summary: 'Refactor validation', flags: {} };
const wire = { schema_version: '1', task, choices: { executors: ['primary', 'replan'], model_tiers: ['cheap','balanced','strong','max'],
  reasoning_efforts: ['minimal','low','medium','high'], context_budgets: ['tiny','small','medium','large'],
  test_depths: ['none','targeted','standard','full'], review_depths: ['none','targeted','standard','full'], integration_strategies: ['direct','isolated','staged','replan'] } };
const domains = { executor: 'executors', model_tier: 'model_tiers', reasoning_effort: 'reasoning_efforts', context_budget: 'context_budgets', test_depth: 'test_depths', review_depth: 'review_depths', integration_strategy: 'integration_strategies' };
const selections = { executor: 'primary', model_tier: 'balanced', reasoning_effort: 'medium', context_budget: 'small', test_depth: 'targeted', review_depth: 'targeted', integration_strategy: 'direct' };
function valid() {
  const answers = {};
  for (const [field, domain] of Object.entries(domains)) {
    const options = wire.choices[domain];
    answers[field] = { type: 'choice', choice: selections[field], confidence: 0.95,
      probabilities: Object.fromEntries(options.map(option => [option, option === selections[field] ? 0.8 : 0.2 / (options.length - 1)])) };
  }
  answers.parallel_safe = { type: 'noul', noul: 0.95 };
  return { answers, model: 'fixture-model', usage: { input_tokens: 12, output_tokens: 0 } };
}
const config = endpoint => ({ version: '1', provider_id: 'local-system-one', executors: ['primary','replan'], executable: process.execPath,
  cli_entrypoint: resolve('examples/judgment/system-one-bridge.mjs'), args: [endpoint, 'fixture-model'] });
const runtime = (endpoint, extra = {}) => createDecisionRuntime(selectJudgmentAdapter('process')(config(endpoint), ['primary','replan']),
  { executors: { primary: null, replan: null }, ...extra });
async function fixture(handler = (_req,res) => res.end(JSON.stringify(valid())), host = '127.0.0.1') {
  const calls = []; let arrived;
  const firstCall = new Promise(done => { arrived = done; });
  const server = createServer(async (req,res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) }); arrived();
    res.setHeader('Content-Type', 'application/json'); handler(req,res);
  });
  servers.push(server);
  await new Promise((done,reject) => { server.once('error',reject); server.listen(0,host,done); });
  return { endpoint: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}/v1/systemone`, calls, firstCall };
}
beforeAll(async () => {
  await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  ({ inferSystemOneJudgment, validateEndpoint, mapSystemOneJudgment, systemOneRequest } = await import('../examples/judgment/system-one-bridge.mjs'));
}, 30000);
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => { server.close(done); server.closeAllConnections(); })));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
it('uses one native POST via the empty-environment process adapter, preserving every Choice statistic', async () => {
  const f = await fixture();
  const oldProxy = process.env.HTTP_PROXY, oldSecret = process.env.TASKSTANCE_LOCAL_SECRET;
  process.env.HTTP_PROXY = 'http://192.0.2.1:9'; process.env.TASKSTANCE_LOCAL_SECRET = 'SECRET_SENTINEL';
  let result;
  try { result = await runtime(f.endpoint).decider.decide(task); }
  finally {
    if (oldProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldProxy;
    if (oldSecret === undefined) delete process.env.TASKSTANCE_LOCAL_SECRET; else process.env.TASKSTANCE_LOCAL_SECRET = oldSecret;
  }
  expect(result.source).toBe('provider+policy');
  for (const field of Object.keys(domains)) expect(result.judgment.decisions[field]).toEqual({ selected: valid().answers[field].choice, confidence: 0.95, probabilities: valid().answers[field].probabilities });
  expect(result.judgment.decisions.parallel_safe).toEqual({ selected: true, probability_true: 0.95 });
  expect(f.calls).toHaveLength(1);
  const call = f.calls[0]; expect(call).toMatchObject({ method: 'POST', url: '/v1/systemone' });
  expect(call.body).toEqual(systemOneRequest(wire, 'fixture-model'));
  for (const [field,domain] of Object.entries(domains)) expect(Object.keys(call.body.questions[field].criteria)).toEqual(wire.choices[domain]);
  expect(call.body.questions.parallel_safe.type).toBe('noul');
  expect(call.headers).not.toHaveProperty('authorization');
  expect(JSON.stringify(call)).not.toMatch(/SECRET_SENTINEL|provider_id|cli_entrypoint|repo_contents/);
});
it.each([0,0.1,0.5,0.899999,0.9,1])('preserves Noul P(true) %s with a conservative threshold and no confidence', p => {
  const raw = valid(); raw.answers.parallel_safe.noul = p;
  expect(mapSystemOneJudgment(wire,raw).decisions.parallel_safe).toEqual({ selected: p >= 0.9, probability_true: p });
});
it.each(['missing-confidence','null-confidence','bad-confidence','wrong-type','bad-choice','bad-key','missing-key','sum','negative','nonfinite','noul-type','noul-range','unexpected','malformed','duplicate','escaped-duplicate','nested-duplicate','deep'])('rejects %s without retry or diagnostic leakage', async mode => {
  const raw = valid(); const a = raw.answers.executor;
  if (mode === 'missing-confidence') delete a.confidence;
  if (mode === 'null-confidence') a.confidence = null;
  if (mode === 'bad-confidence') a.confidence = 1.1;
  if (mode === 'wrong-type') a.type = 'score';
  if (mode === 'bad-choice') a.choice = 'unknown';
  if (mode === 'bad-key') a.probabilities.unknown = 0;
  if (mode === 'missing-key') delete a.probabilities.replan;
  if (mode === 'sum') a.probabilities.primary = 0.4;
  if (mode === 'negative') a.probabilities.primary = -0.1;
  if (mode === 'noul-type') raw.answers.parallel_safe = { type: 'choice', noul: 0.95 };
  if (mode === 'noul-range') raw.answers.parallel_safe.noul = 1.1;
  if (mode === 'unexpected') raw.answers.unknown = { type: 'noul', noul: 0.5 };
  let text = JSON.stringify(raw);
  if (mode === 'nonfinite') text = text.replace('"confidence":0.95','"confidence":1e999');
  if (mode === 'malformed') text = 'SECRET_SENTINEL{';
  if (mode === 'duplicate') text = '{"answers":{},"answers":{}}';
  if (mode === 'escaped-duplicate') text = '{"answers":{},"answe\\u0072s":{}}';
  if (mode === 'nested-duplicate') text = text.replace('"primary":0.8','"primary":0.8,"primary":0.8');
  if (mode === 'deep') text = '{"answers":{},"extra":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}';
  const f = await fixture((_req,res) => res.end(text));
  const result = await runtime(f.endpoint).decider.decide(task);
  expect(result).toMatchObject({ source: 'fallback', profile: { executor: 'replan' } });
  expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL'); expect(f.calls).toHaveLength(1);
});
it('keeps missing answers missing and lets Core fall back', async () => {
  const raw = valid(); delete raw.answers.review_depth;
  const f = await fixture((_req,res) => res.end(JSON.stringify(raw)));
  const result = await runtime(f.endpoint).decider.decide(task);
  expect(result.source).toBe('fallback'); expect(result.judgment.decisions).not.toHaveProperty('review_depth');
});
it('does not use option probability as confidence and retains low-confidence policy', async () => {
  const raw = valid(); raw.answers.executor.confidence = 0.2;
  const f = await fixture((_req,res) => res.end(JSON.stringify(raw)));
  const result = await runtime(f.endpoint).decider.decide(task);
  expect(result.profile.executor).toBe('replan'); expect(result.judgment.decisions.executor.confidence).toBe(0.2);
});
it.each(['security_critical','destructive'])('preserves deterministic %s safety floors', async flag => {
  const f = await fixture(); const result = await runtime(f.endpoint).decider.decide({ ...task, flags: { [flag]: true } });
  expect(result.source).toBe('provider+policy');
  expect(result.profile).toMatchObject({ reasoning_effort: 'high', test_depth: 'full', review_depth: 'full', parallel_safe: false, integration_strategy: 'staged' });
});
it.each(['empty','singleton','duplicate','bad-label'])('rejects unsupported %s domains before inference', async mode => {
  const raw = structuredClone(wire);
  raw.choices.executors = mode === 'singleton' ? ['primary'] : mode === 'duplicate' ? ['primary','primary'] : mode === 'bad-label' ? ['primary','\n'] : [];
  const f = await fixture();
  await expect(inferSystemOneJudgment(raw,{endpoint:f.endpoint,model:'fixture'})).rejects.toThrow(); expect(f.calls).toHaveLength(0);
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
    const pending = (direct ? inferSystemOneJudgment(wire, { endpoint: f.endpoint, model: 'fixture-model' }, controller.signal) :
      new JudgmentProcessAdapter(config(f.endpoint)).decide(task, controller.signal)).catch(error => error);
    await f.firstCall; controller.abort(); expect(await pending).toBeInstanceOf(Error); expect(f.calls).toHaveLength(1);
  }
});
it('pre-cancellation and oversized requests make zero HTTP calls', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  await expect(inferSystemOneJudgment(wire, { endpoint: f.endpoint, model: 'fixture' }, controller.signal)).rejects.toThrow();
  const oversized = structuredClone(wire);
  oversized.task.flags = Object.fromEntries(Array.from({length: 10000}, (_, i) => ['flag'+i, true]));
  await expect(inferSystemOneJudgment(oversized, {endpoint: f.endpoint, model: 'fixture'})).rejects.toThrow('limit');
  expect(f.calls).toHaveLength(0);
});
it.each(['http://localhost:1234/v1/systemone','http://127.1:1234/v1/systemone',
  'http://2130706433:1234/v1/systemone','http://127.0.0.2:1234/v1/systemone',
  'https://127.0.0.1:1234/v1/systemone','http://user:pass@127.0.0.1:1234/v1/systemone',
  'http://127.0.0.1:65536/v1/systemone','http://127.0.0.1:0/v1/systemone',
  'http://127.0.0.1:1234/v1/systemone?key=x','http://127.0.0.1:1234/v1/systemone#x',
  'http://127.0.0.1:1234/x/../v1/systemone','http://[::ffff:127.0.0.1]:1234/v1/systemone',
  'http://example.com:1234/v1/systemone'])('rejects endpoint %s before connecting', endpoint => {
  expect(() => validateEndpoint(endpoint)).toThrow();
});
it('supports literal IPv6 loopback', async () => {
  const f = await fixture(undefined, '::1');
  expect(await inferSystemOneJudgment(wire, { endpoint: f.endpoint, model: 'fixture' })).toEqual(mapSystemOneJudgment(wire, valid()));
});
it.each(['', ' ', undefined, 'x'.repeat(129), 'bad\nmodel'])('requires an explicit bounded model identifier', async model => {
  const f = await fixture(); await expect(inferSystemOneJudgment(wire, { endpoint: f.endpoint, model })).rejects.toThrow();
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
it.each(['headers', 'wrong-content-type', 'truncated-body'])('rejects HTTP %s with one request', async mode => {
  const f = await fixture((_req,res) => {
    if (mode === 'headers') res.setHeader('X-Large', 'x'.repeat(8193));
    if (mode === 'wrong-content-type') res.setHeader('Content-Type', 'text/plain');
    if (mode === 'truncated-body') res.setHeader('Content-Length', 100000);
    res.end(JSON.stringify(valid()));
    if (mode === 'truncated-body') res.socket?.destroy();
  });
  expect((await runtime(f.endpoint).decider.decide(task)).source).toBe('fallback');
  expect(f.calls).toHaveLength(1);
});
it.each([undefined, null, [], {}, { answers: [] }, { answers: { executor: null } }])('rejects wrong answer envelopes %j', raw => {
  expect(() => mapSystemOneJudgment(wire,raw)).toThrow();
});
it('preserves an empty answers object without fabricating decisions', async () => {
  const f = await fixture((_req,res) => res.end('{"answers":{}}'));
  const result = await runtime(f.endpoint).decider.decide(task);
  expect(result.source).toBe('fallback'); expect(result.judgment.decisions).toEqual({});
});
it.each([NaN, Infinity, -Infinity, -0.1, 1.1, '0.9', null])('rejects invalid direct numerical values %s', value => {
  const raw = valid(); raw.answers.executor.confidence = value;
  expect(() => mapSystemOneJudgment(wire,raw)).toThrow();
  raw.answers.executor.confidence = 0.95; raw.answers.parallel_safe.noul = value;
  expect(() => mapSystemOneJudgment(wire,raw)).toThrow();
});
it('ignores optional metadata and extensions rather than leaking them into Core', () => {
  const raw = valid(); raw.extra = 'SECRET_SENTINEL'; raw.answers.executor.extra = 'SECRET_SENTINEL';
  expect(mapSystemOneJudgment(wire,raw)).toEqual(mapSystemOneJudgment(wire,valid()));
});
it('accepts probability rounding within tolerance without changing values, and rejects material error', () => {
  const raw = valid(); raw.answers.executor.probabilities = { primary: 0.8, replan: 0.1999999 };
  expect(mapSystemOneJudgment(wire,raw).decisions.executor.probabilities).toEqual(raw.answers.executor.probabilities);
  raw.answers.executor.probabilities.replan = 0.199;
  expect(() => mapSystemOneJudgment(wire,raw)).toThrow();
});
it('rejects duplicate stdin members without inference', async () => {
  const f = await fixture();
  const { stdout, stderr } = await new Promise((done,reject) => {
    const child = spawn(process.execPath,[config(f.endpoint).cli_entrypoint,...config(f.endpoint).args],{env:{},stdio:['pipe','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => { stdout += chunk; }); child.stderr.on('data',chunk => { stderr += chunk; });
    child.on('error',reject); child.on('close',() => done({stdout,stderr}));
    child.stdin.end(JSON.stringify(wire).replace('"schema_version":"1"','"schema_version":"1","schema_version":"1"'));
  });
  expect(JSON.parse(stdout).available).toBe(false); expect(stderr).toBe(''); expect(f.calls).toHaveLength(0);
});
