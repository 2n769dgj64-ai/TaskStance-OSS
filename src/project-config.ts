import { z } from "zod";
import { TelemetryModeSchema } from "./telemetry.js";

export const ProjectConfigSchema = z.strictObject({
  version: z.literal("1"),
  executors: z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), z.string().min(1).max(240).nullable()),
  default_executor: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  telemetry: TelemetryModeSchema.default("off"),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const defaultProjectConfig: ProjectConfig = {
  version: "1",
  executors: {
    primary: "Primary coding executor",
    secondary: "Secondary coding executor",
    replan: "Stop and replan instead of executing",
  },
  default_executor: "primary",
  telemetry: "off",
};

export function parseProjectConfig(raw: unknown): ProjectConfig {
  return ProjectConfigSchema.parse(raw);
}
