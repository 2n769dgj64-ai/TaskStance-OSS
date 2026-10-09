import { describe, expect, it } from "vitest";
import { assembleDiscovery } from "../src/discovery-assembler.js";

describe("assembleDiscovery", () => {
  it("deduplicates deterministically and preserves mandatory evidence", () => {
    const result = assembleDiscovery({
      data_classification: "engineering_non_sensitive",
      task_id: "discover-test",
      attempt_id: "a1",
      task_summary: "Refactor authentication boundary",
      max_estimated_tokens: 5000,
      batches: [
        {
          adapter_id: "rg",
          status: "complete",
          hits: [
            {
              id: "src/auth.ts",
              kind: "file",
              summary: "Text-search hit in auth implementation",
              estimated_tokens: 900,
              source: "text_search",
            },
            {
              id: "src/session.ts",
              kind: "file",
              summary: "Session helper",
              estimated_tokens: 700,
              source: "text_search",
            },
          ],
        },
        {
          adapter_id: "git",
          status: "complete",
          hits: [
            {
              id: "src/auth.ts",
              kind: "file",
              summary: "Explicitly changed authentication file",
              estimated_tokens: 1100,
              mandatory: true,
              source: "changed_file",
            },
          ],
        },
      ],
    });

    expect(result.reason).toBe("ready");
    expect(result.discovery_complete).toBe(true);
    expect(result.requires_replan).toBe(false);
    expect(result.input_hit_count).toBe(3);
    expect(result.deduplicated_candidate_count).toBe(2);
    expect(result.candidates).toEqual([
      {
        id: "src/auth.ts",
        kind: "file",
        summary: "Explicitly changed authentication file",
        estimated_tokens: 1100,
        mandatory: true,
      },
      {
        id: "src/session.ts",
        kind: "file",
        summary: "Session helper",
        estimated_tokens: 700,
        mandatory: false,
      },
    ]);
    expect(result.prune_input?.discovery_complete).toBe(true);
  });

  it("marks the handoff incomplete when any discovery source is truncated", () => {
    const result = assembleDiscovery({
      data_classification: "engineering_non_sensitive",
      task_id: "discover-test",
      attempt_id: "a1",
      task_summary: "Cross-module change",
      max_estimated_tokens: 5000,
      batches: [
        {
          adapter_id: "symbols",
          status: "truncated",
          hits: [
            {
              id: "src/core.ts",
              kind: "file",
              summary: "Explicit task target",
              estimated_tokens: 800,
              mandatory: true,
              source: "explicit",
            },
            {
              id: "src/helper.ts",
              kind: "file",
              summary: "Related symbol hit",
              estimated_tokens: 600,
              source: "symbol",
            },
          ],
        },
      ],
    });

    expect(result.reason).toBe("source_incomplete");
    expect(result.discovery_complete).toBe(false);
    expect(result.requires_replan).toBe(true);
    expect(result.prune_input?.discovery_complete).toBe(false);
    expect(result.candidates[0]?.mandatory).toBe(true);
  });

  it("preserves mandatory candidates before applying the optional cap", () => {
    const result = assembleDiscovery({
      data_classification: "engineering_non_sensitive",
      task_id: "discover-test",
      attempt_id: "a1",
      task_summary: "Cap candidates conservatively",
      max_estimated_tokens: 5000,
      max_candidates: 2,
      batches: [
        {
          adapter_id: "mixed",
          status: "complete",
          hits: [
            {
              id: "src/mandatory.ts",
              kind: "file",
              summary: "Must keep",
              estimated_tokens: 500,
              mandatory: true,
              source: "explicit",
            },
            {
              id: "docs/low.md",
              kind: "doc",
              summary: "Lower-priority documentation",
              estimated_tokens: 300,
              source: "documentation",
            },
            {
              id: "src/changed.ts",
              kind: "file",
              summary: "Higher-priority changed file",
              estimated_tokens: 400,
              source: "changed_file",
            },
          ],
        },
      ],
    });

    expect(result.reason).toBe("candidate_cap_truncated");
    expect(result.discovery_complete).toBe(false);
    expect(result.requires_replan).toBe(true);
    expect(result.dropped_optional_count).toBe(1);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "src/mandatory.ts",
      "src/changed.ts",
    ]);
    expect(result.prune_input?.discovery_complete).toBe(false);
  });

  it("fails closed instead of dropping mandatory context when mandatory count exceeds the cap", () => {
    const result = assembleDiscovery({
      data_classification: "engineering_non_sensitive",
      task_id: "discover-test",
      attempt_id: "a1",
      task_summary: "Too many mandatory candidates",
      max_estimated_tokens: 5000,
      max_candidates: 1,
      batches: [
        {
          adapter_id: "explicit",
          status: "complete",
          hits: [
            {
              id: "src/a.ts",
              kind: "file",
              summary: "Required A",
              estimated_tokens: 400,
              mandatory: true,
              source: "explicit",
            },
            {
              id: "src/b.ts",
              kind: "file",
              summary: "Required B",
              estimated_tokens: 400,
              mandatory: true,
              source: "explicit",
            },
          ],
        },
      ],
    });

    expect(result.reason).toBe("mandatory_overflow");
    expect(result.requires_replan).toBe(true);
    expect(result.discovery_complete).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.prune_input).toBeUndefined();
  });

  it("fails closed on conflicting kinds for the same candidate id", () => {
    const result = assembleDiscovery({
      data_classification: "engineering_non_sensitive",
      task_id: "discover-test",
      attempt_id: "a1",
      task_summary: "Ambiguous discovery identity",
      max_estimated_tokens: 5000,
      batches: [
        {
          adapter_id: "a",
          status: "complete",
          hits: [
            {
              id: "shared-id",
              kind: "file",
              summary: "File interpretation",
              estimated_tokens: 400,
              source: "text_search",
            },
          ],
        },
        {
          adapter_id: "b",
          status: "complete",
          hits: [
            {
              id: "shared-id",
              kind: "symbol",
              summary: "Symbol interpretation",
              estimated_tokens: 200,
              source: "symbol",
            },
          ],
        },
      ],
    });

    expect(result.reason).toBe("conflicting_candidate_kind");
    expect(result.requires_replan).toBe(true);
    expect(result.prune_input).toBeUndefined();
  });

  it("requires replan when discovery returns no candidates", () => {
    const result = assembleDiscovery({
      data_classification: "engineering_non_sensitive",
      task_id: "discover-test",
      attempt_id: "a1",
      task_summary: "No evidence found",
      max_estimated_tokens: 5000,
      batches: [{ adapter_id: "rg", status: "complete", hits: [] }],
    });

    expect(result.reason).toBe("no_candidates");
    expect(result.discovery_complete).toBe(true);
    expect(result.requires_replan).toBe(true);
    expect(result.prune_input).toBeUndefined();
  });

  it("rejects duplicate adapter ids", () => {
    expect(() =>
      assembleDiscovery({
        data_classification: "engineering_non_sensitive",
        task_id: "discover-test",
        attempt_id: "a1",
        task_summary: "Duplicate adapter identity",
        max_estimated_tokens: 5000,
        batches: [
          { adapter_id: "rg", status: "complete", hits: [] },
          { adapter_id: "rg", status: "complete", hits: [] },
        ],
      }),
    ).toThrow("Duplicate discovery adapter_id: rg");
  });
});
