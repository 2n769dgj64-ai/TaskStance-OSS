#!/usr/bin/env node
import { open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark, runDirectBenchmark, verifyPairing } from "./runner.js";
import { generateBenchmarkReport } from "./report.js";
import { BenchmarkManifestSchema } from "./schemas.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "report" && args.length >= 2) {
    const [output, ...inputs] = args;
    const results = await Promise.all(inputs.map(async p => JSON.parse(await readFile(resolve(p), "utf8")) as unknown));
    await writeFile(resolve(output!), generateBenchmarkReport(results), { flag: "wx" });
    return;
  }
  if (command === "run" && args.length === 3 && args[2] === "--live") {
    const manifest = resolve(args[0]!);
    const parsed = BenchmarkManifestSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
    // Refuse an existing/unwritable output before any potentially paid execution.
    const output = await open(resolve(args[1]!), "wx");
    try {
      const result = await runBenchmark(parsed, {
        live: true, config_root: dirname(manifest),
        taskstance_repository: fileURLToPath(new URL("../../", import.meta.url)),
      });
      await output.writeFile(`${JSON.stringify(result, null, 2)}\n`);
      if (result.outcome !== "passed") process.exitCode = 1;
    } finally { await output.close(); }
    return;
  }
  // Opt-in comparison arm: requires explicit --live authorization and a paired TaskStance result; no other form is accepted.
  if (command === "run" && args.length === 7 && args[2] === "--live" && args[3] === "--mode" && args[4] === "direct" && args[5] === "--pair-with") {
    const manifest = resolve(args[0]!);
    const parsed = BenchmarkManifestSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
    const paired = JSON.parse(await readFile(resolve(args[6]!), "utf8")) as unknown;
    const options = { live: true, config_root: dirname(manifest), taskstance_repository: fileURLToPath(new URL("../../", import.meta.url)) };
    // Pairing is verified before the output file exists and before any network access or executor launch.
    await verifyPairing(parsed, paired, options);
    const output = await open(resolve(args[1]!), "wx");
    try {
      const result = await runDirectBenchmark(parsed, paired, options);
      await output.writeFile(`${JSON.stringify(result, null, 2)}\n`);
      if (result.outcome !== "passed") process.exitCode = 1;
    } finally { await output.close(); }
    return;
  }
  throw new Error("usage");
}
main().catch(() => {
  process.stderr.write("Benchmark command refused. Usage: run <manifest.json> <new-result.json> --live [--mode direct --pair-with <taskstance-result.json>] | report <new-report.md> <result.json>...\n");
  process.exitCode = 1;
});
