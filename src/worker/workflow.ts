import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import { getSandbox, collectFile } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type {
  Config as OpencodeConfig,
  OpencodeClient,
} from "@opencode-ai/sdk";
import type { Env, ScreenshotManifest, UploadedScreenshot } from "./types";
import { buildSystemPrompt } from "./prompt";
import {
  screenshotR2Key,
  uploadScreenshot,
  buildCommentMarkdown,
  syncLogsToR2,
  syncMessagesToR2,
} from "./storage";
import {
  createOctokit,
  getInstallationToken,
  fetchPRDiff,
  fetchChangedFiles,
  fetchPRDetails,
  postPRComment,
} from "./github";
import { updateRunStatus } from "./db";
import { bestEffort, withTimeout, invariant } from "./utils";

// ─── Timeout budget per sandbox operation (ms) ─────────────────────────────
// Each is set below its parent step.do timeout so the JS-level Promise.race
// fires before Cloudflare's step timeout, giving us a clean error + stack.

const T = {
  DOCKER_READY: 45_000,
  EXEC_QUICK: 15_000,
  GIT_CLONE: 4 * 60_000,
  GIT_FETCH: 2 * 60_000,
  WRITE_FILE: 30_000,
  EXPOSE_PORT: 30_000,
  SET_ENV: 15_000,
  CREATE_OPENCODE: 60_000,
  SESSION_CREATE: 30_000,
  SESSION_PROMPT: 60_000,
  WAIT_AGENT: 11 * 60_000,
  READ_FILE: 30_000,
  UPLOAD_LOOP: 2.5 * 60_000,
  CLEANUP: 20_000,
} as const;

// ─── Workflow params ────────────────────────────────────────────────────────

export interface WorkflowParams {
  sandboxId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  installationId: number;
}

// ─── Workflow ───────────────────────────────────────────────────────────────

const AGENT_TIMEOUT_SECS = 600; // 10 minutes

export class ScreenshotWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowParams
> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const p = event.payload;

    try {
      await step.do("mark-running", () =>
        updateRunStatus(this.env.DB, p.sandboxId, "running"),
      );
      await this.cloneRepo(step, p);
      await this.writeContext(step, p);
      await this.startAgent(step, p);
      const manifestFound = await this.waitForAgent(step, p);
      if (manifestFound) {
        await this.uploadAndComment(step, p);
      }
      await step.do("mark-completed", () =>
        updateRunStatus(this.env.DB, p.sandboxId, "complete"),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Unknown error");
      await bestEffort(() =>
        step.do("mark-failed", () =>
          updateRunStatus(this.env.DB, p.sandboxId, "errored", message),
        ),
      );
    }

    await this.cleanup(step, p);
  }

  private async cloneRepo(step: WorkflowStep, p: WorkflowParams) {
    await step.do("clone-repo", { timeout: "5 minutes" }, async () => {
      const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
      const token = await getInstallationToken(this.env, p.installationId);

      const dockerReady = await withTimeout(
        sandbox.exec(
          "timeout 30 sh -c 'until docker version >/dev/null 2>&1; do sleep 0.5; done'",
        ),
        T.DOCKER_READY,
      );
      invariant(dockerReady.success, "Docker did not become ready in time");

      await withTimeout(
        sandbox.exec("touch /workspace/agent.log"),
        T.EXEC_QUICK,
      );
      await withTimeout(
        sandbox.exec("rm -rf /workspace/repo"),
        T.EXEC_QUICK,
      );

      await withTimeout(
        sandbox.gitCheckout(
          `https://x-access-token:${token}@github.com/${p.owner}/${p.repo}.git`,
          { targetDir: "/workspace/repo" },
        ),
        T.GIT_CLONE,
      );

      const verifyResult = await withTimeout(
        sandbox.exec(
          "test -d /workspace/repo/.git && echo EXISTS || echo MISSING",
        ),
        T.EXEC_QUICK,
      );
      invariant(
        verifyResult.stdout?.includes("EXISTS"),
        "gitCheckout did not create /workspace/repo",
      );

      const fetchResult = await withTimeout(
        sandbox.exec(
          `cd /workspace/repo && git fetch origin pull/${p.prNumber}/head && git checkout ${p.commitSha}`,
        ),
        T.GIT_FETCH,
      );
      invariant(
        fetchResult.success,
        `git fetch/checkout failed (exit ${fetchResult.exitCode}): ${fetchResult.stderr}`,
      );
    });
  }

  private async writeContext(step: WorkflowStep, p: WorkflowParams) {
    await step.do("write-context", { timeout: "2 minutes" }, async () => {
      const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
      const octokit = createOctokit(this.env, p.installationId);

      const [prDetails, diff, changedFiles] = await Promise.all([
        fetchPRDetails(octokit, p.owner, p.repo, p.prNumber),
        fetchPRDiff(octokit, p.owner, p.repo, p.prNumber),
        fetchChangedFiles(octokit, p.owner, p.repo, p.prNumber),
      ]);

      await withTimeout(
        sandbox.exec("mkdir -p /workspace/context /workspace/screenshots"),
        T.EXEC_QUICK,
      );
      await withTimeout(
        sandbox.writeFile(
          "/workspace/context/pr-description.md",
          `# ${prDetails.title}\n\n${prDetails.body}`,
        ),
        T.WRITE_FILE,
      );
      await withTimeout(
        sandbox.writeFile("/workspace/context/pr-diff.patch", diff),
        T.WRITE_FILE,
      );
      await withTimeout(
        sandbox.writeFile(
          "/workspace/context/changed-files.json",
          JSON.stringify(changedFiles, null, 2),
        ),
        T.WRITE_FILE,
      );
    });
  }

  private async startAgent(step: WorkflowStep, p: WorkflowParams) {
    await step.do("start-agent", { timeout: "3 minutes" }, async () => {
      const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);

      const exposed = await withTimeout(
        sandbox.exposePort(8080, { hostname: "vd.tractorbeam.ai" }),
        T.EXPOSE_PORT,
      );

      const envVars: Record<string, string> = {
        PATH: "/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      };
      if (this.env.BRAINTRUST_API_KEY) {
        envVars.BRAINTRUST_API_KEY = this.env.BRAINTRUST_API_KEY;
        envVars.TRACE_TO_BRAINTRUST = "true";
        envVars.BRAINTRUST_PROJECT = "visual-diff";
      }
      await withTimeout(sandbox.setEnvVars(envVars), T.SET_ENV);

      const systemPrompt = buildSystemPrompt({
        cdpUrl: `wss://vd.tractorbeam.ai/cdp?secret=${this.env.INTERNAL_SECRET}`,
        previewUrl: exposed.url,
        screenshotSecret: this.env.INTERNAL_SECRET,
      });

      const dir = "/workspace";
      const { client, server } = await withTimeout(
        createOpencode<OpencodeClient>(sandbox, {
          directory: dir,
          config: {
            ...(this.env.BRAINTRUST_API_KEY && {
              plugin: ["@braintrust/trace-opencode"],
            }),
            provider: {
              anthropic: {
                options: { apiKey: this.env.ANTHROPIC_API_KEY },
              },
            },
            model: "anthropic/claude-sonnet-4-5",
            permission: {
              edit: "allow",
              bash: "allow",
              webfetch: "allow",
            },
            agent: { build: { maxSteps: 80 } },
          } satisfies OpencodeConfig,
        }),
        T.CREATE_OPENCODE,
      );

      try {
        const session = await withTimeout(
          client.session.create({
            body: { title: "Visual Diff Agent" },
            query: { directory: dir },
          }),
          T.SESSION_CREATE,
        );
        invariant(
          !session.error && session.data,
          `Failed to create session: ${JSON.stringify(session.error ?? session)}`,
        );

        const sid = session.data.id;

        await withTimeout(
          sandbox.writeFile(
            "/workspace/opencode-session.json",
            JSON.stringify({ sessionId: sid, directory: dir }),
          ),
          T.WRITE_FILE,
        );

        const promptResult = await withTimeout(
          client.session.promptAsync({
            path: { id: sid },
            query: { directory: dir },
            body: {
              model: {
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5",
              },
              system: systemPrompt,
              parts: [
                {
                  type: "text" as const,
                  text: "Analyze the PR and take screenshots of affected pages. Follow all instructions in the system prompt.",
                },
              ],
            },
          }),
          T.SESSION_PROMPT,
        );
        invariant(
          !promptResult.error,
          `Failed to send prompt: ${JSON.stringify(promptResult.error)}`,
        );

        return { sessionId: sid, directory: dir };
      } finally {
        await server.close();
      }
    });
  }

  private async waitForAgent(
    step: WorkflowStep,
    p: WorkflowParams,
  ): Promise<boolean> {
    return step.do(
      "wait-for-agent",
      { timeout: "12 minutes", retries: { limit: 2, delay: "5 seconds" } },
      async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
        const result = await withTimeout(
          sandbox.exec(
            `for i in $(seq 1 ${AGENT_TIMEOUT_SECS}); do ` +
              `[ -f /workspace/screenshot-manifest.json ] && echo FOUND && exit 0; ` +
              `sleep 1; ` +
              `done; echo TIMEOUT`,
          ),
          T.WAIT_AGENT,
        );
        return result.stdout?.includes("FOUND") ?? false;
      },
    );
  }

  private async uploadAndComment(step: WorkflowStep, p: WorkflowParams) {
    await step.do(
      "upload-and-comment",
      { timeout: "3 minutes", retries: { limit: 2, delay: "5 seconds" } },
      async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
        const manifestResult = await withTimeout(
          sandbox.readFile("/workspace/screenshot-manifest.json"),
          T.READ_FILE,
        );
        const manifest: ScreenshotManifest = JSON.parse(
          manifestResult.content,
        );

        const octokit = createOctokit(this.env, p.installationId);

        if (manifest.screenshots.length === 0) {
          await postPRComment(
            octokit,
            p.owner,
            p.repo,
            p.prNumber,
            `## Visual Diff\n\nNo screenshots were taken for commit \`${p.commitSha.slice(0, 7)}\`. The agent could not determine which pages to screenshot, or the app failed to start.`,
          );
          return;
        }

        const uploaded: UploadedScreenshot[] = [];
        const uploadAll = async () => {
          for (const entry of manifest.screenshots) {
            const stream = await sandbox.readFileStream(entry.path);
            const { content } = await collectFile(stream);
            const data =
              content instanceof Uint8Array
                ? content
                : new TextEncoder().encode(content);
            const key = screenshotR2Key(
              p.owner,
              p.repo,
              p.sandboxId,
              entry.route,
            );
            const url = await uploadScreenshot(this.env, key, data);
            uploaded.push({
              route: entry.route,
              description: entry.description,
              url,
            });
          }
        };
        await withTimeout(uploadAll(), T.UPLOAD_LOOP);

        const commentBody = buildCommentMarkdown(p.commitSha, uploaded);
        await postPRComment(
          octokit,
          p.owner,
          p.repo,
          p.prNumber,
          commentBody,
        );
      },
    );
  }

  private async cleanup(step: WorkflowStep, p: WorkflowParams) {
    await bestEffort(() =>
      step.do("cleanup", { timeout: "30 seconds" }, async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);

        await bestEffort(() =>
          withTimeout(
            (async () => {
              const logResult = await sandbox.exec(
                "cat /workspace/agent.log 2>/dev/null || true",
              );
              if (logResult.stdout?.trim()) {
                await syncLogsToR2(
                  this.env,
                  p.owner,
                  p.repo,
                  p.sandboxId,
                  logResult.stdout,
                );
              }
            })(),
            T.CLEANUP,
          ),
        );

        await bestEffort(() =>
          withTimeout(
            (async () => {
              const sessionFile = await sandbox.readFile(
                "/workspace/opencode-session.json",
              );
              const { sessionId: sid, directory: dir } = JSON.parse(
                sessionFile.content,
              );
              const { client: c, server: s } =
                await createOpencode<OpencodeClient>(sandbox, {
                  directory: dir,
                });
              try {
                const { data: msgs } = await c.session.messages({
                  path: { id: sid },
                  query: { directory: dir },
                });
                if (msgs && (msgs as unknown[]).length > 0) {
                  await syncMessagesToR2(
                    this.env,
                    p.owner,
                    p.repo,
                    p.sandboxId,
                    msgs as unknown[],
                  );
                }
              } finally {
                await s.close();
              }
            })(),
            T.CLEANUP,
          ),
        );

        await bestEffort(() =>
          withTimeout(sandbox.killAllProcesses(), T.EXEC_QUICK),
        );
        await bestEffort(() =>
          withTimeout(sandbox.destroy(), T.EXEC_QUICK),
        );
      }),
    );
  }
}
