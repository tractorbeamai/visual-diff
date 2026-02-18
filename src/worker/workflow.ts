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
      // ── Mark running ───────────────────────────────────────────────────
      await step.do("mark-running", async () => {
        await updateRunStatus(this.env.DB, p.sandboxId, "running");
      });

      // ── Clone repo ─────────────────────────────────────────────────────
      await step.do("clone-repo", { timeout: "5 minutes" }, async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
        const token = await getInstallationToken(this.env, p.installationId);

        await sandbox.exec(
          "timeout 30 sh -c 'until docker version >/dev/null 2>&1; do sleep 0.5; done'",
        );
        await sandbox.exec("touch /workspace/agent.log");
        await sandbox.exec("rm -rf /workspace/repo");
        await sandbox.gitCheckout(
          `https://x-access-token:${token}@github.com/${p.owner}/${p.repo}.git`,
          { targetDir: "repo" },
        );
        await sandbox.exec(
          `cd /workspace/repo && git fetch origin pull/${p.prNumber}/head && git checkout ${p.commitSha}`,
        );
      });

      // ── Fetch PR data and write context files ──────────────────────────
      await step.do("write-context", { timeout: "2 minutes" }, async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
        const octokit = createOctokit(this.env, p.installationId);

        const [prDetails, diff, changedFiles] = await Promise.all([
          fetchPRDetails(octokit, p.owner, p.repo, p.prNumber),
          fetchPRDiff(octokit, p.owner, p.repo, p.prNumber),
          fetchChangedFiles(octokit, p.owner, p.repo, p.prNumber),
        ]);

        await sandbox.exec(
          "mkdir -p /workspace/context /workspace/screenshots",
        );
        await sandbox.writeFile(
          "/workspace/context/pr-description.md",
          `# ${prDetails.title}\n\n${prDetails.body}`,
        );
        await sandbox.writeFile("/workspace/context/pr-diff.patch", diff);
        await sandbox.writeFile(
          "/workspace/context/changed-files.json",
          JSON.stringify(changedFiles, null, 2),
        );
      });

      // ── Start agent ────────────────────────────────────────────────────
      await step.do("start-agent", { timeout: "3 minutes" }, async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);

        const exposed = await sandbox.exposePort(8080, {
          hostname: "vd.tractorbeam.ai",
        });

        await sandbox.setEnvVars({
          PATH: "/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        });

        const systemPrompt = buildSystemPrompt({
          cdpUrl: `wss://vd.tractorbeam.ai/cdp?secret=${this.env.INTERNAL_SECRET}`,
          previewUrl: exposed.url,
          screenshotSecret: this.env.INTERNAL_SECRET,
        });

        const dir = "/workspace";
        const { client, server } = await createOpencode<OpencodeClient>(
          sandbox,
          {
            directory: dir,
            config: {
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
          },
        );

        try {
          const session = await client.session.create({
            body: { title: "Visual Diff Agent" },
            query: { directory: dir },
          });

          if (session.error || !session.data) {
            throw new Error(
              `Failed to create session: ${JSON.stringify(session.error ?? session)}`,
            );
          }

          const sid = session.data.id;

          // Persist so /messages endpoint can find the session
          await sandbox.writeFile(
            "/workspace/opencode-session.json",
            JSON.stringify({ sessionId: sid, directory: dir }),
          );

          const promptResult = await client.session.promptAsync({
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
          });

          if (promptResult.error) {
            throw new Error(
              `Failed to send prompt: ${JSON.stringify(promptResult.error)}`,
            );
          }

          return { sessionId: sid, directory: dir };
        } finally {
          await server.close();
        }
      });

      // ── Wait for agent completion ────────────────────────────────────
      // Instead of polling from the workflow (N network round-trips per
      // iteration), we push the wait into the sandbox with a single
      // blocking exec call. The shell loop checks the local filesystem
      // with zero network overhead. Cancellation is handled implicitly:
      // registerRun/killRun call instance.terminate() + sandbox.destroy(),
      // which kills the exec and the workflow.
      const manifestFound = await step.do(
        "wait-for-agent",
        { timeout: "12 minutes", retries: { limit: 2, delay: "5 seconds" } },
        async () => {
          const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
          const result = await sandbox.exec(
            `for i in $(seq 1 ${AGENT_TIMEOUT_SECS}); do ` +
              `[ -f /workspace/screenshot-manifest.json ] && echo FOUND && exit 0; ` +
              `sleep 1; ` +
              `done; echo TIMEOUT`,
          );
          return result.stdout?.includes("FOUND") ?? false;
        },
      );

      // ── Upload and comment ─────────────────────────────────────────────
      if (manifestFound) {
        await step.do(
          "upload-and-comment",
          { timeout: "3 minutes", retries: { limit: 2, delay: "5 seconds" } },
          async () => {
            const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);
            const manifestResult = await sandbox.readFile(
              "/workspace/screenshot-manifest.json",
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

      // ── Mark completed ─────────────────────────────────────────────────
      await step.do("mark-completed", async () => {
        await updateRunStatus(this.env.DB, p.sandboxId, "completed");
      });
    } catch {
      // Best-effort: mark the run as failed
      try {
        await step.do("mark-failed", async () => {
          await updateRunStatus(this.env.DB, p.sandboxId, "failed");
        });
      } catch {
        // Even marking failed may fail
      }
    }

    // ── Cleanup (always runs) ──────────────────────────────────────────
    try {
      await step.do("cleanup", { timeout: "30 seconds" }, async () => {
        const sandbox = getSandbox(this.env.Sandbox, p.sandboxId);

        // Final log flush
        try {
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
        } catch {
          // Best effort
        }

        // Final message flush (reads session metadata from sandbox)
        try {
          const sessionFile = await sandbox.readFile(
            "/workspace/opencode-session.json",
          );
          const { sessionId: sid, directory: dir } = JSON.parse(
            sessionFile.content,
          );
          const { client: c, server: s } = await createOpencode<OpencodeClient>(
            sandbox,
            { directory: dir },
          );
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
        } catch {
          // Best effort
        }

        // Destroy sandbox
        try {
          await sandbox.killAllProcesses();
        } catch {
          // Best effort
        }
        try {
          await sandbox.destroy();
        } catch {
          // Best effort
        }
      });
    } catch {
      // Best-effort cleanup
    }
  }
}
