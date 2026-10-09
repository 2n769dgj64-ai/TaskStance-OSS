import type { ContextCandidate, ContextPruneInput } from "./context-contracts.js";
import type { TaskInput } from "./contracts.js";
import type { RuntimeProviderBundle } from "./runtime-core.js";

export function createUnavailableProviderBundle(id = "offline"): RuntimeProviderBundle {
  return {
    id,
    configured: false,
    model: null,
    judgmentProvider: {
      async decide(_task: TaskInput) {
        return {
          schema_version: "2",
          available: false,
          unavailable_reason_code: "UNKNOWN",
          provider: id,
        };
      },
    },
    contextScoringProvider: {
      async score(_input: ContextPruneInput, _candidates: ContextCandidate[]) {
        return {
          schema_version: "1",
          available: false,
          unavailable_reason_code: "UNKNOWN",
          provider: id,
        };
      },
    },
  };
}
