import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../sandbox-agent/prompt";

describe("buildSystemPrompt", () => {
  const config = {
    cdpUrl: "wss://vd.tractorbeam.ai/cdp?secret=test-secret",
    previewUrl: "https://8080-sandbox-abc123.vd.tractorbeam.ai",
    screenshotSecret: "screenshot-secret-123",
  };

  const prompt = buildSystemPrompt(config);

  it.each([
    ["cdpUrl", config.cdpUrl],
    ["previewUrl", config.previewUrl],
    ["screenshotSecret", config.screenshotSecret],
    ["X-Screenshot-Auth header", "X-Screenshot-Auth"],
    ["port 8080 instruction", "port 8080"],
    ["port 3000 warning", "NOT port 3000"],
    ["CLAUDE.md instruction", "CLAUDE.md"],
    ["agent-browser CDP flag", "agent-browser --cdp"],
    ["/workspace/screenshots/ path", "/workspace/screenshots/"],
  ])("includes %s", (_label, expected) => {
    expect(prompt).toContain(expected);
  });
});
