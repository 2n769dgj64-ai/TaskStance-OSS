import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/prelaunch-audit.mjs", import.meta.url));

describe("pre-launch audit", () => {
  it("self-tests fail-closed publication/privacy/package rules without network calls", async () => {
    const { stdout } = await execFileAsync(process.execPath, [script, "self-test"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 64 * 1024,
    });
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      positive_fixture: true,
      lifecycle_script_rejected: true,
      secret_like_artifact_rejected: true,
      private_residue_rejected: true,
      core_integration_leak_rejected: true,
      publish_workflow_rejected: true,
      evaluation_artifact_rejected: true,
      no_secret_contents_reported: true,
      identity_and_entrypoints_rejected: true,
      transitive_core_leak_rejected: true,
      unexpected_benchmark_result_rejected: true,
      historical_evidence_changes_rejected: true,
      claims_and_metadata_required: true,
      ineffective_ignore_rules_rejected: true,
    });
  }, 60_000);
});
