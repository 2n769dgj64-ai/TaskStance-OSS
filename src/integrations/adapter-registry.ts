import { CodexAdapterConfigSchema, CodexExecutorAdapter } from "./codex.js";
import type { LocalContextFile } from "./local-context.js";

/** Static CLI integration factory; deliberately not part of the Core exports. */
const adapters = {
  codex(rawConfig: unknown) {
    const config = CodexAdapterConfigSchema.parse(rawConfig);
    return {
      executor: config.executor,
      create: (workspace: string, files: LocalContextFile[]) => new CodexExecutorAdapter(config, workspace, files),
    };
  },
};

export function selectAdapter(name: string | undefined) {
  if (!name) throw new Error("run requires --adapter <name>");
  if (name !== "codex") throw new Error(`Unknown adapter: ${name}`);
  return adapters[name];
}
