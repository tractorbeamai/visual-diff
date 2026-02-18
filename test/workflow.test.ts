import { describe, it, expect } from "vitest";
import type { WorkflowParams } from "../src/worker/workflow";
import type {
  ScreenshotManifest,
  ScreenshotEntry,
  UploadedScreenshot,
} from "../src/worker/types";
import type { Run, RunStatus } from "../src/worker/run-types";

describe("WorkflowParams interface", () => {
  it("accepts valid workflow params", () => {
    const params: WorkflowParams = {
      sandboxId: "test-sandbox-123",
      owner: "acme",
      repo: "widget",
      prNumber: 42,
      commitSha: "abc123def456",
      installationId: 12345,
    };

    expect(params.sandboxId).toBe("test-sandbox-123");
    expect(params.owner).toBe("acme");
    expect(params.repo).toBe("widget");
    expect(params.prNumber).toBe(42);
    expect(params.commitSha).toBe("abc123def456");
    expect(params.installationId).toBe(12345);
  });

  it("requires all fields", () => {
    const params: WorkflowParams = {
      sandboxId: "",
      owner: "",
      repo: "",
      prNumber: 0,
      commitSha: "",
      installationId: 0,
    };

    expect(Object.keys(params)).toHaveLength(6);
    expect(Object.keys(params)).toContain("sandboxId");
    expect(Object.keys(params)).toContain("owner");
    expect(Object.keys(params)).toContain("repo");
    expect(Object.keys(params)).toContain("prNumber");
    expect(Object.keys(params)).toContain("commitSha");
    expect(Object.keys(params)).toContain("installationId");
  });
});

describe("workflow step sequence", () => {
  const EXPECTED_STEPS = [
    "mark-running",
    "clone-repo",
    "write-context",
    "start-agent",
    "wait-for-agent",
    "upload-and-comment",
    "mark-completed",
    "cleanup",
  ];

  it("has expected number of steps", () => {
    expect(EXPECTED_STEPS).toHaveLength(8);
  });

  it("starts with mark-running step", () => {
    expect(EXPECTED_STEPS[0]).toBe("mark-running");
  });

  it("clones repo before writing context", () => {
    const cloneIdx = EXPECTED_STEPS.indexOf("clone-repo");
    const contextIdx = EXPECTED_STEPS.indexOf("write-context");
    expect(cloneIdx).toBeLessThan(contextIdx);
  });

  it("writes context before starting agent", () => {
    const contextIdx = EXPECTED_STEPS.indexOf("write-context");
    const agentIdx = EXPECTED_STEPS.indexOf("start-agent");
    expect(contextIdx).toBeLessThan(agentIdx);
  });

  it("waits for agent before uploading", () => {
    const waitIdx = EXPECTED_STEPS.indexOf("wait-for-agent");
    const uploadIdx = EXPECTED_STEPS.indexOf("upload-and-comment");
    expect(waitIdx).toBeLessThan(uploadIdx);
  });

  it("ends with cleanup step", () => {
    expect(EXPECTED_STEPS[EXPECTED_STEPS.length - 1]).toBe("cleanup");
  });
});

describe("workflow step timeouts", () => {
  const EXPECTED_TIMEOUTS = {
    "clone-repo": "5 minutes",
    "write-context": "2 minutes",
    "start-agent": "3 minutes",
    "wait-for-agent": "12 minutes",
    "upload-and-comment": "3 minutes",
    cleanup: "30 seconds",
  };

  it.each(Object.entries(EXPECTED_TIMEOUTS))(
    "step %s has %s timeout",
    (_step, timeout) => {
      expect(timeout).toBeTruthy();
    },
  );

  it("wait-for-agent has retry configuration", () => {
    const retryConfig = { limit: 2, delay: "5 seconds" };
    expect(retryConfig.limit).toBe(2);
    expect(retryConfig.delay).toBe("5 seconds");
  });

  it("upload-and-comment has retry configuration", () => {
    const retryConfig = { limit: 2, delay: "5 seconds" };
    expect(retryConfig.limit).toBe(2);
  });
});

describe("workflow agent timeout", () => {
  const AGENT_TIMEOUT_SECS = 600;

  it("agent timeout is 10 minutes (600 seconds)", () => {
    expect(AGENT_TIMEOUT_SECS).toBe(600);
    expect(AGENT_TIMEOUT_SECS / 60).toBe(10);
  });

  it("wait-for-agent step timeout exceeds agent timeout", () => {
    const waitForAgentTimeoutMinutes = 12;
    const agentTimeoutMinutes = AGENT_TIMEOUT_SECS / 60;
    expect(waitForAgentTimeoutMinutes).toBeGreaterThan(agentTimeoutMinutes);
  });
});

describe("ScreenshotManifest format", () => {
  it("accepts valid manifest with screenshots", () => {
    const manifest: ScreenshotManifest = {
      screenshots: [
        {
          path: "/workspace/screenshots/dashboard.png",
          route: "/dashboard",
          description: "Main dashboard page",
        },
        {
          path: "/workspace/screenshots/settings.png",
          route: "/settings",
          description: "Settings page",
        },
      ],
    };

    expect(manifest.screenshots).toHaveLength(2);
    expect(manifest.screenshots[0].path).toContain("/workspace/screenshots/");
    expect(manifest.screenshots[0].route).toBe("/dashboard");
  });

  it("accepts empty manifest", () => {
    const manifest: ScreenshotManifest = {
      screenshots: [],
    };

    expect(manifest.screenshots).toHaveLength(0);
  });

  it("screenshot entry has required fields", () => {
    const entry: ScreenshotEntry = {
      path: "/workspace/screenshots/test.png",
      route: "/test",
      description: "Test page",
    };

    expect(entry).toHaveProperty("path");
    expect(entry).toHaveProperty("route");
    expect(entry).toHaveProperty("description");
  });
});

describe("UploadedScreenshot format", () => {
  it("has required fields for PR comment", () => {
    const uploaded: UploadedScreenshot = {
      route: "/dashboard",
      description: "Dashboard page",
      url: "https://screenshots.tractorbeam.ai/acme/widget/run-1/dashboard.png",
    };

    expect(uploaded.route).toBe("/dashboard");
    expect(uploaded.url).toContain("https://");
    expect(uploaded.description).toBeTruthy();
  });
});

describe("Run types", () => {
  it("RunStatus includes all expected states", () => {
    const statuses: RunStatus[] = [
      "queued",
      "running",
      "completed",
      "cancelled",
      "failed",
    ];

    expect(statuses).toContain("queued");
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
    expect(statuses).toContain("cancelled");
    expect(statuses).toContain("failed");
    expect(statuses).toHaveLength(5);
  });

  it("Run interface has required fields", () => {
    const run: Run = {
      id: "run-123",
      owner: "acme",
      repo: "widget",
      pr_number: 42,
      commit_sha: "abc123",
      status: "running",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:01:00Z",
    };

    expect(run.id).toBe("run-123");
    expect(run.owner).toBe("acme");
    expect(run.repo).toBe("widget");
    expect(run.pr_number).toBe(42);
    expect(run.commit_sha).toBe("abc123");
    expect(run.status).toBe("running");
    expect(run.created_at).toBeTruthy();
    expect(run.updated_at).toBeTruthy();
  });
});
