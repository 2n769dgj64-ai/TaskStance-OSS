import { describe, expect, it } from "vitest";
import {
  defaultExecutionPresets,
  parseExecutionPresets,
  resolveContextBudget,
} from "../src/execution-presets.js";

describe("execution presets", () => {
  it("resolves built-in qualitative context budgets deterministically", () => {
    expect(resolveContextBudget(defaultExecutionPresets, "tiny")).toEqual({
      schema_version: "1",
      context_budget: "tiny",
      max_estimated_tokens: 4000,
      max_candidates: 8,
      min_relevance: 0.5,
    });
    expect(resolveContextBudget(defaultExecutionPresets, "large")).toEqual({
      schema_version: "1",
      context_budget: "large",
      max_estimated_tokens: 64000,
      max_candidates: 64,
      min_relevance: 0.5,
    });
  });

  it("accepts explicit provider-neutral preset configuration", () => {
    const presets = parseExecutionPresets({
      version: "1",
      context_budgets: {
        tiny: { max_estimated_tokens: 2000, max_candidates: 4, min_relevance: 0.7 },
        small: { max_estimated_tokens: 8000, max_candidates: 12, min_relevance: 0.6 },
        medium: { max_estimated_tokens: 20000, max_candidates: 24, min_relevance: 0.55 },
        large: { max_estimated_tokens: 48000, max_candidates: 48, min_relevance: 0.5 },
      },
    });
    expect(resolveContextBudget(presets, "small")).toMatchObject({
      max_estimated_tokens: 8000,
      max_candidates: 12,
      min_relevance: 0.6,
    });
  });

  it("fails closed when larger tiers shrink limits", () => {
    expect(() =>
      parseExecutionPresets({
        ...defaultExecutionPresets,
        context_budgets: {
          ...defaultExecutionPresets.context_budgets,
          large: {
            ...defaultExecutionPresets.context_budgets.large,
            max_candidates: 16,
          },
        },
      }),
    ).toThrow("Context budget candidate limits must be non-decreasing");
  });
});
