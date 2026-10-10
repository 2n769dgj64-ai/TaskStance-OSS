// Synthetic, offline fixture only. Not a real model and never uses the network.
const mode = process.argv[2] ?? 'valid';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const scores = request.candidates.map((candidate, i) => ({
  id: candidate.id, relevance: i === 0 ? 0.95 : 0.1,
}));
const valid = {schema_version:'1',available:true,scores};
let response = valid;
if (mode === 'missing') response = {...valid,scores:scores.slice(1)};
if (mode === 'duplicate') response = {...valid,scores:scores.map(() => scores[0])};
if (mode === 'unknown') response = {...valid,scores:[...scores.slice(0,-1),{id:'missing-id',relevance:0.5}]};
if (mode === 'invalid-score') response = {...valid,scores:scores.map(v=>({...v,relevance:2}))};
if (mode === 'spoof-provider') response = {...valid,provider:'attacker'};
if (mode === 'unavailable') response = {schema_version:'1',available:false,unavailable_reason_code:'UNKNOWN'};
if (mode === 'env-check') response = process.env.TASKSTANCE_PROCESS_SECRET ? {schema_version:'1',available:false} : valid;
if (mode === 'echo-content-check') {
  const allowed = ['schema_version', 'task', 'candidates'];
  const safe = Object.keys(request).every(key => allowed.includes(key)) &&
    Object.keys(request.task).every(key => ['data_classification','task_id','attempt_id','task_summary'].includes(key)) &&
    request.candidates.every(candidate =>
      Object.keys(candidate).every(key => ['id','kind','summary','estimated_tokens'].includes(key)));
  response = safe && !JSON.stringify(request).includes('DO_NOT_SEND_FILE_CONTENT') ? valid :
    {schema_version:'1',available:false};
}
if (mode === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (mode === 'nonzero') process.exit(1);
if (mode === 'malformed') {process.stdout.write('{not-json');process.exit(0);}
if (mode === 'duplicate-member') {process.stdout.write('{"schema_version":"1","available":false,"available":true}');process.exit(0);}
if (mode === 'oversized') {process.stdout.write('x'.repeat(262145));process.exit(0);}
process.stdout.write(JSON.stringify(response));
