// Local mock only: these source labels illustrate translation, not a JEV protocol.
import { pathToFileURL } from "node:url";
import {
  JudgmentProcessRequestSchema, JudgmentProcessResponseSchema,
} from "taskstance/integrations/judgment-process";

const mappings = {
  executor: { implementer: "primary", planner: "replan" },
  model_tier: { cheap: "cheap", balanced: "balanced", strong: "strong", max: "max" },
  reasoning_effort: { minimal: "minimal", low: "low", medium: "medium", high: "high" },
  context_budget: { tiny: "tiny", small: "small", medium: "medium", large: "large" },
  test_depth: { none: "none", targeted: "targeted", standard: "standard", full: "full" },
  review_depth: { none: "none", targeted: "targeted", standard: "standard", full: "full" },
  integration_strategy: { direct: "direct", isolated: "isolated", staged: "staged", replan: "replan" },
};
const domains = {
  executor: "executors", model_tier: "model_tiers", reasoning_effort: "reasoning_efforts",
  context_budget: "context_budgets", test_depth: "test_depths", review_depth: "review_depths",
  integration_strategy: "integration_strategies",
};

/** Translate an illustrative source response; never invent missing decisions or confidence. */
export function mapReferenceJudgment(rawRequest, rawResponse) {
  const request = JudgmentProcessRequestSchema.parse(rawRequest);
  const response = JudgmentProcessResponseSchema.parse(rawResponse);
  if (!response.decisions) return response;
  const decisions = { ...response.decisions };
  for (const [field, mapping] of Object.entries(mappings)) {
    const decision = decisions[field];
    if (!decision) continue;
    const translate = value => {
      if (!Object.hasOwn(mapping, value) || !request.choices[domains[field]].includes(mapping[value])) {
        throw new Error("Unsupported judgment mapping");
      }
      return mapping[value];
    };
    decisions[field] = {
      ...decision, selected: translate(decision.selected),
      ...(decision.probabilities ? { probabilities: Object.fromEntries(
        Object.entries(decision.probabilities).map(([value, probability]) => [translate(value), probability]),
      ) } : {}),
    };
  }
  return JudgmentProcessResponseSchema.parse({ ...response, decisions });
}

export function mockJudgment(mode = "valid") {
  const choice = selected => ({ selected, confidence: 0.95 });
  const response = {
    schema_version: "1", available: true,
    decisions: {
      executor: choice("implementer"), model_tier: choice("balanced"), reasoning_effort: choice("medium"),
      context_budget: choice("small"), test_depth: choice("targeted"), review_depth: choice("targeted"),
      parallel_safe: { selected: true, probability_true: 0.95 }, integration_strategy: choice("direct"),
    },
  };
  if (mode === "unavailable") return { schema_version: "1", available: false, unavailable_reason_code: "UNKNOWN" };
  if (mode === "missing") delete response.decisions.review_depth;
  else if (mode === "low-confidence") response.decisions.executor.confidence = 0.2;
  else if (mode === "invalid") response.decisions.model_tier.selected = "unsupported";
  else if (mode !== "valid") throw new Error("Unknown mock mode");
  return response;
}

async function main() {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 65536) throw new Error("Request too large");
      chunks.push(chunk);
    }
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    // A real bridge would make one documented model call here, replacing mockJudgment.
    const response = mapReferenceJudgment(request, mockJudgment(process.argv[2]));
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch {
    // No prompts, raw responses, credentials, or parse diagnostics in output.
    process.stdout.write('{"schema_version":"1","available":false,"unavailable_reason_code":"INVALID_RESPONSE"}\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
