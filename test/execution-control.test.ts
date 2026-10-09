import { describe, expect, it } from "vitest";
import { prepareTaskExecution } from "../src/execution-control.js";
import { createUnavailableProviderBundle } from "../src/offline-providers.js";
import { createDecisionRuntime } from "../src/runtime-core.js";

function runtime() {
  return createDecisionRuntime(createUnavailableProviderBundle(), {
    executors: {
      primary: "Primary executor",
      secondary: "Secondary executor",
      replan: "Stop and replan",
    },
    defaultExecutor: "primary",
  });
}

describe("execution control", () => {
  it("turns a deterministic task into a dry-run prepared execution", async () => {
    const prepared = await prepareTaskExecution(runtime(), {
      data_classification: "engineering_non_sensitive",
      summary: "Update documentation.",
      flags: { docs_only: true },
    });

    expect(prepared.executor).toBe("primary");
    expect(prepared.decision_source).toBe("deterministic");
    expect(prepared.resolved_context_budget.context_budget).toBe("tiny");
  });

  it("fails conservatively into the replan executor when no provider is configured", async () => {
    const prepared = await prepareTaskExecution(runtime(), {
      data_classification: "engineering_non_sensitive",
      task_id: "phase2-offline",
      attempt_id: "a1",
      summary: "Refactor a runtime module.",
      flags: {},
    });

    expect(prepared.executor).toBe("replan");
    expect(prepared.decision_source).toBe("fallback");
    expect(prepared.profile.integration_strategy).toBe("replan");
  });
});
