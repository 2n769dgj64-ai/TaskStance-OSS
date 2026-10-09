import { describe, expect, it } from "vitest";
import { defaultProjectConfig, parseProjectConfig } from "../src/project-config.js";


describe("project config", () => {
  it("parses the provider-neutral default config", () => {
    const parsed = parseProjectConfig(defaultProjectConfig);
    expect(parsed.default_executor).toBe("primary");
    expect(parsed.telemetry).toBe("off");
    expect(Object.keys(parsed.executors)).toEqual(["primary", "secondary", "replan"]);
  });

  it("rejects unknown fields", () => {
    expect(() => parseProjectConfig({ ...defaultProjectConfig, provider_key: "secret" })).toThrow();
  });
});
