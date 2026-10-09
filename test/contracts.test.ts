import { describe, expect, it } from "vitest";
import { RawJudgmentSchema, TaskInputSchema } from "../src/contracts.js";

describe("strict execution decision contracts", () => {
  it("rejects unknown task fields instead of stripping them", () => {
    const parsed = TaskInputSchema.safeParse({
      data_classification: "engineering_non_sensitive",
      task_id: "strict-task",
      attempt_id: "a1",
      summary: "Strict contract test",
      flags: {},
      unexpected: "must fail closed",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unapproved data classifications", () => {
    for (const data_classification of ["sensitive", "regulated", "confidential_source"]) {
      const parsed = TaskInputSchema.safeParse({
        data_classification,
        summary: "Must not be admitted",
        flags: {},
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("keeps the 2000-character engineering summary bound", () => {
    const admitted = TaskInputSchema.safeParse({
      data_classification: "engineering_non_sensitive",
      summary: "x".repeat(2000),
      flags: {},
    });
    const rejected = TaskInputSchema.safeParse({
      data_classification: "engineering_non_sensitive",
      summary: "x".repeat(2001),
      flags: {},
    });
    expect(admitted.success).toBe(true);
    expect(rejected.success).toBe(false);
  });

  it("accepts bounded provider identifiers", () => {
    const parsed = RawJudgmentSchema.safeParse({
      schema_version: "2",
      available: false,
      provider: "custom-decider",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown provider judgment fields instead of stripping them", () => {
    const parsed = RawJudgmentSchema.safeParse({
      schema_version: "2",
      available: false,
      provider: "custom-decider",
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });
});
