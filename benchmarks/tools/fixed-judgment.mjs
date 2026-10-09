#!/usr/bin/env node
// Benchmark-only fixed-control judgment process for the generic `process` judgment adapter.
//
// It exercises the real external-process judgment boundary and deterministic policy path.
// It is not an evaluation of adaptive judgment quality: the profile below is constant and
// independent of the task. The script reads exactly one request from stdin, emits exactly
// one response document, and never touches the network, filesystem, Git or environment.
// Provider identity is owned by the local judgment configuration, not by this response.

const PROFILE = Object.freeze({
  executor: "primary",
  model_tier: "balanced",
  reasoning_effort: "medium",
  context_budget: "small",
  test_depth: "targeted",
  review_depth: "targeted",
  integration_strategy: "direct",
});
const CONFIDENCE = 0.99;
const MAX_REQUEST_BYTES = 1_000_000;

const fail = () => { process.exitCode = 1; };

function respond(text) {
  let request;
  try { request = JSON.parse(text); } catch { return fail(); }
  const choices = request?.choices;
  // Shape check only; the task itself is neither inspected nor echoed.
  if (request?.schema_version !== "1" || typeof request.task !== "object" || request.task === null ||
      typeof choices !== "object" || choices === null) return fail();
  const offered = {
    executor: choices.executors, model_tier: choices.model_tiers, reasoning_effort: choices.reasoning_efforts,
    context_budget: choices.context_budgets, test_depth: choices.test_depths, review_depth: choices.review_depths,
    integration_strategy: choices.integration_strategies,
  };
  // Refuse rather than return a value the caller did not offer.
  if (Object.entries(PROFILE).some(([key, value]) => !Array.isArray(offered[key]) || !offered[key].includes(value))) return fail();
  const decisions = {};
  for (const [key, selected] of Object.entries(PROFILE)) decisions[key] = { selected, confidence: CONFIDENCE };
  decisions.parallel_safe = { selected: false, probability_true: 0.01 };
  process.stdout.write(`${JSON.stringify({ schema_version: "1", available: true, decisions })}\n`);
}

let size = 0;
const chunks = [];
process.stdin.on("data", chunk => {
  size += chunk.length;
  if (size > MAX_REQUEST_BYTES) { fail(); process.stdin.destroy(); return; }
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  if (size > MAX_REQUEST_BYTES) return;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { return fail(); }
  respond(text);
});
process.stdin.on("error", fail);
