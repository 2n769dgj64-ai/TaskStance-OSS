import { createUnavailableProviderBundle } from "../offline-providers.js";
import type { RuntimeProviderBundle } from "../runtime-core.js";
import { JudgmentProcessAdapter, JudgmentProcessConfigSchema } from "./judgment-process.js";

const factories = new Map<string, (rawConfig: unknown, executors: string[]) => RuntimeProviderBundle>([
  ["process", (rawConfig, executors) => {
    // CLI diagnostics must not echo arbitrary configuration values.
    try {
      const config = JudgmentProcessConfigSchema.parse(rawConfig);
      if (config.executors.some(executor => !executors.includes(executor))) throw new Error("executor");
      return {
        ...createUnavailableProviderBundle(config.provider_id),
        configured: true,
        judgmentProvider: new JudgmentProcessAdapter(config),
      };
    } catch { throw new Error("Invalid judgment process configuration"); }
  }],
]);

export function selectJudgmentAdapter(name: string | undefined) {
  if (!name) throw new Error("Judgment selection requires --judgment");
  const factory = factories.get(name);
  if (!factory) throw new Error("Unknown judgment adapter");
  return factory;
}
