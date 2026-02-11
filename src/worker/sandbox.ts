import { getSandbox, collectFile } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type {
  Config as OpencodeConfig,
  OpencodeClient,
} from "@opencode-ai/sdk";
import type {
  Env,
  QueueMessage,
  ScreenshotManifest,
  UploadedScreenshot,
} from "./types";
import { buildSystemPrompt } from "./prompt";
import {
  buildR2Key,
  uploadScreenshot,
  buildCommentMarkdown,
  syncLogsToR2,
  syncMessagesToR2,
} from "./storage";
import { createOctokit, getInstallationToken, postPRComment } from "./github";
import { isRunActive, updateRunStatus } from "./db";

// ─── Shared context passed to cleanup helpers ────────────────────────────────

type SandboxStub = ReturnType<typeof getSandbox>;

interface CleanupContext {
  sandbox: SandboxStub;
  client: OpencodeClient;
  server: { close(): Promise<void> };
  sessionId: string;
  directory: string;
  env: Env;
  job: QueueMessage;
  log(message: string): Promise<void>;
  flushLogs(): Promise<void>;
  flushMessages(): Promise<void>;
}

// ─── Extracted helpers ───────────────────────────────────────────────────────

/**
 * Poll the sandbox for agent completion (session idle) or manifest file,
 * periodically flushing logs/messages to R2.
 */
async function pollForCompletion(
  ctx: CleanupContext,
): Promise<{ manifestFound: boolean; cancelled: boolean }> {
  const deadline = Date.now() + 600_000;
  let manifestFound = false;
  let agentDone = false;
  let pollCount = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    pollCount++;

    // Check if this run was cancelled (superseded by a newer run)
    if (pollCount % 10 === 0) {
      const stillActive = await isRunActive(ctx.env.DB, ctx.job.sandboxId);
      if (!stillActive) {
        await ctx.log("Run was cancelled (superseded by a newer run).");
        return { manifestFound: false, cancelled: true };
      }
    }

    // Check manifest every ~10 polls (30s)
    if (pollCount % 10 === 0) {
      const check = await ctx.sandbox.exec(
        "test -f /workspace/screenshot-manifest.json && echo EXISTS",
      );
      if (check.stdout?.includes("EXISTS")) {
        manifestFound = true;
        await ctx.log("Manifest file detected.");
        break;
      }
    }

    // Poll session status to detect when agent finishes
    try {
      const { data: statuses } = await ctx.client.session.status({
        query: { directory: ctx.directory },
      });
      if (statuses) {
        const status = (statuses as Record<string, { type: string }>)[
          ctx.sessionId
        ];
        if (status?.type === "idle" && pollCount > 1) {
          agentDone = true;
        }
      }
    } catch {
      // Non-critical
    }

    // If agent finished, check for manifest one more time then break
    if (agentDone) {
      await ctx.log("Agent session is idle -- checking for manifest...");
      const check = await ctx.sandbox.exec(
        "test -f /workspace/screenshot-manifest.json && echo EXISTS",
      );
      if (check.stdout?.includes("EXISTS")) {
        manifestFound = true;
        await ctx.log("Manifest file detected.");
      } else {
        await ctx.log(
          "Agent finished but no manifest found. Waiting 5s and retrying...",
        );
        await new Promise((r) => setTimeout(r, 5_000));
        const retry = await ctx.sandbox.exec(
          "test -f /workspace/screenshot-manifest.json && echo EXISTS",
        );
        if (retry.stdout?.includes("EXISTS")) {
          manifestFound = true;
          await ctx.log("Manifest file detected on retry.");
        }
      }
      break;
    }

    // Sync logs + messages to R2 every ~30s
    if (pollCount % 10 === 0) {
      await Promise.all([ctx.flushLogs(), ctx.flushMessages()]);
    }
  }

  return { manifestFound, cancelled: false };
}

/**
 * Read the screenshot manifest, upload each screenshot to R2, and post
 * a summary comment on the PR.
 */
async function uploadAndComment(ctx: CleanupContext): Promise<void> {
  await ctx.log("Reading screenshot manifest...");
  const manifestResult = await ctx.sandbox.readFile(
    "/workspace/screenshot-manifest.json",
  );
  const manifest: ScreenshotManifest = JSON.parse(manifestResult.content);

  if (manifest.screenshots.length === 0) {
    await ctx.log("Agent produced no screenshots.");
    const octokit = createOctokit(ctx.env, ctx.job.installationId);
    await postPRComment(
      octokit,
      ctx.job.owner,
      ctx.job.repo,
      ctx.job.prNumber,
      `## Visual Diff\n\nNo screenshots were taken for commit \`${ctx.job.commitSha.slice(0, 7)}\`. The agent could not determine which pages to screenshot, or the app failed to start.`,
    );
    return;
  }

  await ctx.log(
    `Uploading ${manifest.screenshots.length} screenshots to R2...`,
  );
  const uploaded: UploadedScreenshot[] = [];
  for (const entry of manifest.screenshots) {
    const stream = await ctx.sandbox.readFileStream(entry.path);
    const { content } = await collectFile(stream);

    const data =
      content instanceof Uint8Array
        ? content
        : new TextEncoder().encode(content);

    const key = buildR2Key(
      ctx.job.owner,
      ctx.job.repo,
      ctx.job.prNumber,
      entry.route,
    );
    const url = await uploadScreenshot(ctx.env, key, data);

    uploaded.push({
      route: entry.route,
      description: entry.description,
      url,
    });
    await ctx.log(`  Uploaded: ${entry.route}`);
  }

  await ctx.log("Posting PR comment...");
  const octokit = createOctokit(ctx.env, ctx.job.installationId);
  const commentBody = buildCommentMarkdown(ctx.job.commitSha, uploaded);
  await postPRComment(
    octokit,
    ctx.job.owner,
    ctx.job.repo,
    ctx.job.prNumber,
    commentBody,
  );

  await ctx.log(
    `Done! Posted ${uploaded.length} screenshots to PR #${ctx.job.prNumber}.`,
  );
  console.log(
    `Posted ${uploaded.length} screenshots to PR #${ctx.job.prNumber}`,
  );
}

/**
 * Best-effort teardown: flush data to R2, update run status, close the
 * OpenCode server, kill sandbox processes, and destroy the sandbox.
 */
async function cleanupResources(
  ctx: CleanupContext,
  finalStatus: "completed" | "failed" | null,
): Promise<void> {
  // Flush logs + messages to R2 BEFORE updating run status.
  // This ensures R2 has the final data when the frontend sees the
  // status change and switches from live sandbox to R2 fallback.
  await Promise.all([ctx.flushLogs(), ctx.flushMessages()]);
  if (finalStatus) {
    try {
      await updateRunStatus(ctx.env.DB, ctx.job.sandboxId, finalStatus);
    } catch {
      // Best effort
    }
  }
  try {
    await ctx.server.close();
  } catch {
    // Best effort
  }
  try {
    await ctx.sandbox.killAllProcesses();
  } catch {
    // Best effort
  }
  try {
    await ctx.sandbox.destroy();
    console.log(`Sandbox ${ctx.job.sandboxId.slice(0, 8)} destroyed`);
  } catch {
    // Best effort
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Start a screenshot job: spin up sandbox, clone repo, start the OpenCode
 * agent, and fire off the prompt.
 *
 * Returns a cleanup closure that polls for the manifest, uploads screenshots,
 * posts the PR comment, and tears down the sandbox. The caller should ack the
 * queue message after this returns, then run the closure via ctx.waitUntil()
 * so the long-running work doesn't block the queue consumer.
 */
export async function startScreenshotJob(
  job: QueueMessage,
  env: Env,
): Promise<() => Promise<void>> {
  const sandbox = getSandbox(env.Sandbox, job.sandboxId);

  // Strip secrets (git tokens, etc.) from messages before logging
  const sanitize = (msg: string) =>
    msg.replace(/x-access-token:[^\s@]+/g, "x-access-token:***");

  // Helper to append a timestamped line to the log file
  const log = async (message: string) => {
    const clean = sanitize(message);
    const ts = new Date().toISOString();
    await sandbox.exec(
      `echo '${ts} ${clean.replace(/'/g, "'\\''")}'  >> /workspace/agent.log`,
    );
  };

  // Run a command and forward its stdout/stderr to the log
  const run = async (
    command: string,
    opts?: { cwd?: string; label?: string },
  ) => {
    const label = opts?.label ?? command.slice(0, 80);
    await log(`$ ${label}`);
    const result = await sandbox.exec(
      command,
      opts?.cwd ? { cwd: opts.cwd } : undefined,
    );
    if (result.stdout?.trim()) {
      for (const line of result.stdout.trim().split("\n")) {
        await log(`  ${sanitize(line)}`);
      }
    }
    if (result.stderr?.trim()) {
      for (const line of result.stderr.trim().split("\n")) {
        await log(`  [stderr] ${sanitize(line)}`);
      }
    }
    return result;
  };

  try {
    await sandbox.exec("touch /workspace/agent.log");
    await log("Job started for " + `${job.owner}/${job.repo}#${job.prNumber}`);
  } catch {
    // Sandbox not ready yet
  }

  // Get installation token for git clone
  await log("Fetching installation token...");
  const token = await getInstallationToken(env, job.installationId);

  // Clone the repo and check out the PR head commit.
  // Clean up first in case this is a retry on the same sandbox.
  await log("Cloning repository...");
  await sandbox.exec("rm -rf /workspace/repo");
  await sandbox.gitCheckout(
    `https://x-access-token:${token}@github.com/${job.owner}/${job.repo}.git`,
    { targetDir: "repo" },
  );

  await log(`Checking out commit ${job.commitSha.slice(0, 7)}...`);
  await run(
    `git fetch origin pull/${job.prNumber}/head && git checkout ${job.commitSha}`,
    {
      cwd: "/workspace/repo",
      label: `git checkout ${job.commitSha.slice(0, 7)}`,
    },
  );

  // Write PR context files for the agent to read
  await log("Writing PR context files...");
  await run("mkdir -p /workspace/context /workspace/screenshots");
  await sandbox.writeFile(
    "/workspace/context/pr-description.md",
    `# ${job.prTitle}\n\n${job.prDescription}`,
  );
  await sandbox.writeFile("/workspace/context/pr-diff.patch", job.prDiff);
  await sandbox.writeFile(
    "/workspace/context/changed-files.json",
    JSON.stringify(job.changedFiles, null, 2),
  );

  // Pre-expose port 8080 so routing is ready before the dev server starts
  await log("Exposing preview port...");
  const exposed = await sandbox.exposePort(8080, {
    hostname: "vd.tractorbeam.ai",
  });

  // Ensure opencode is on PATH (Dockerfile ENV doesn't survive sandbox overlay)
  await sandbox.setEnvVars({
    PATH: "/root/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  });

  const systemPrompt = buildSystemPrompt({
    cdpUrl: `wss://vd.tractorbeam.ai/cdp?secret=${env.INTERNAL_SECRET}`,
    previewUrl: exposed.url,
    screenshotSecret: env.INTERNAL_SECRET,
  });

  const directory = "/workspace";

  // Start OpenCode server and get a typed SDK client
  await log("Starting OpenCode agent...");
  const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
    directory,
    config: {
      provider: {
        anthropic: {
          options: {
            apiKey: env.ANTHROPIC_API_KEY,
          },
        },
      },
      model: "anthropic/claude-sonnet-4-5",
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
      },
      agent: {
        build: {
          maxSteps: 80,
        },
      },
    } satisfies OpencodeConfig,
  });
  await log(`OpenCode server started on port ${server.port}`);

  // Create session
  const session = await client.session.create({
    body: { title: "Visual Diff Agent" },
    query: { directory },
  });

  if (session.error) {
    throw new Error(
      `Failed to create session: ${JSON.stringify(session.error)}`,
    );
  }
  if (!session.data) {
    throw new Error(
      `Session create returned no data: ${JSON.stringify(session)}`,
    );
  }

  const sessionId = session.data.id;
  await log(`Session created: ${sessionId}`);

  // Persist session metadata so the /messages endpoint can find the session
  await sandbox.writeFile(
    "/workspace/opencode-session.json",
    JSON.stringify({ sessionId, directory }),
  );

  await log("Sending prompt (async)...");

  // Use promptAsync so the HTTP call returns immediately (204) and the agent
  // runs in the background inside the container. The synchronous `prompt()`
  // method keeps the HTTP connection open for the entire agent run, which
  // gets killed by intermediate proxy/subrequest timeouts causing a hang.
  const promptResult = await client.session.promptAsync({
    path: { id: sessionId },
    query: { directory },
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

  // Helper: read agent.log from sandbox and persist to R2
  const flushLogs = async () => {
    try {
      const result = await sandbox.exec(
        "cat /workspace/agent.log 2>/dev/null || true",
      );
      const content = result.stdout ?? "";
      if (content.trim()) {
        await syncLogsToR2(env, job.owner, job.repo, job.sandboxId, content);
      }
    } catch (err) {
      console.error("flushLogs failed:", err);
    }
  };

  // Helper: fetch agent messages from OpenCode and persist to R2
  const flushMessages = async () => {
    try {
      const { data: msgs } = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
      });
      if (msgs && (msgs as unknown[]).length > 0) {
        await syncMessagesToR2(
          env,
          job.owner,
          job.repo,
          job.sandboxId,
          msgs as unknown[],
        );
      }
    } catch (err) {
      console.error("flushMessages failed:", err);
    }
  };

  await log("--- AGENT_START ---");
  await flushLogs();

  // Build the shared context for cleanup helpers
  const ctx: CleanupContext = {
    sandbox,
    client,
    server,
    sessionId,
    directory,
    env,
    job,
    log,
    flushLogs,
    flushMessages,
  };

  // ── Cleanup closure ─────────────────────────────────────────────────────
  // The caller runs this via ctx.waitUntil() after ack'ing the queue message,
  // so the 10-minute polling loop doesn't block subsequent jobs.
  return async () => {
    let finalStatus: "completed" | "failed" | null = "failed";

    try {
      const { manifestFound, cancelled } = await pollForCompletion(ctx);

      if (cancelled) {
        finalStatus = null;
        return;
      }

      await ctx.log("--- AGENT_END ---");
      await Promise.all([ctx.flushLogs(), ctx.flushMessages()]);

      if (!manifestFound) {
        await ctx.log("ERROR: Agent timed out after 10 minutes.");
        throw new Error(
          "Agent timed out after 10 minutes without producing a manifest",
        );
      }

      await uploadAndComment(ctx);
      finalStatus = "completed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await ctx.log(`ERROR: ${message}`);
      } catch {
        // Log helper may fail if sandbox is gone
      }
      throw err;
    } finally {
      await cleanupResources(ctx, finalStatus);
    }
  };
}
