import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/worker/prompt";

describe("buildSystemPrompt", () => {
  const config = {
    cdpUrl: "wss://example.com/cdp?secret=test-secret",
    previewUrl: "https://preview.example.com",
    screenshotSecret: "screenshot-auth-token",
  };

  it("includes CDP URL in browser connection command", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(`agent-browser --cdp "${config.cdpUrl}"`);
  });

  it("includes screenshot auth header setup", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(
      `agent-browser set headers {"X-Screenshot-Auth": "${config.screenshotSecret}"}`,
    );
  });

  it("includes preview URL for navigation", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(`agent-browser open ${config.previewUrl}{route}`);
  });

  it("instructs to use port 8080", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("on port 8080");
    expect(prompt).toContain("Port 3000 is reserved");
  });

  it("includes context file paths", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("/workspace/context/pr-description.md");
    expect(prompt).toContain("/workspace/context/pr-diff.patch");
    expect(prompt).toContain("/workspace/context/changed-files.json");
  });

  it("specifies screenshot manifest format", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("/workspace/screenshot-manifest.json");
    expect(prompt).toContain('"screenshots"');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"route"');
    expect(prompt).toContain('"description"');
  });

  it("includes agent config file priorities", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(".cursor/environment.json");
    expect(prompt).toContain(".cursor/rules/*.mdc");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("CLAUDE.md");
  });

  it("includes CI config paths", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(".github/workflows/*.yml");
    expect(prompt).toContain(".gitlab-ci.yml");
    expect(prompt).toContain(".circleci/config.yml");
  });

  it("specifies screenshot directory", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("/workspace/screenshots/");
  });

  it("mentions viewport size recommendation", () => {
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain("1280x720");
  });
});
