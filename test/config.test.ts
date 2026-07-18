import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("keeps Recall disabled when no API key is available", () => {
    const config = loadConfig({});

    expect(config.recall).toBeUndefined();
    expect(config.codex.reasoningEffort).toBe("low");
    expect(config.analysisDelayMs).toBe(12_000);
  });

  it("normalizes public and Recall base URLs", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://scout.example/",
      RECALL_API_KEY: "test-key",
      RECALL_API_BASE_URL: "https://eu-west-2.recall.ai/"
    });

    expect(config.publicBaseUrl).toBe("https://scout.example");
    expect(config.recall?.apiBaseUrl).toBe("https://eu-west-2.recall.ai");
  });

  it("rejects unsupported reasoning effort", () => {
    expect(() =>
      loadConfig({ CODEX_REASONING_EFFORT: "ultra" })
    ).toThrow(/low, medium, or high/);
  });
});
