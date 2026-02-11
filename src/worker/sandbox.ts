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
import { buildR2Key, uploadScreenshot, buildCommentMarkdown } from "./storage";
import { createOctokit, getInstallationToken, postPRComment } from "./github";

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

  await log("Agent is working...");

  // ── Cleanup closure ─────────────────────────────────────────────────────
  // The caller runs this via ctx.waitUntil() after ack'ing the queue message,
  // so the 10-minute polling loop doesn't block subsequent jobs.
  return async () => {
    try {
      // Poll for manifest + session status every 3s.
      // Message progress is now served by the /messages endpoint; the
      // cleanup closure only needs to detect completion.
      const deadline = Date.now() + 600_000;
      let manifestFound = false;
      let agentDone = false;
      let pollCount = 0;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3_000));
        pollCount++;

        // Check manifest every ~10 polls (30s)
        if (pollCount % 10 === 0) {
          const check = await sandbox.exec(
            "test -f /workspace/screenshot-manifest.json && echo EXISTS",
          );
          if (check.stdout?.includes("EXISTS")) {
            manifestFound = true;
            await log("Manifest file detected.");
            break;
          }
        }

        // Poll session status to detect when agent finishes
        try {
          const { data: statuses } = await client.session.status({
            query: { directory },
          });
          if (statuses) {
            const status = (statuses as Record<string, { type: string }>)[
              sessionId
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
          await log("Agent session is idle -- checking for manifest...");
          const check = await sandbox.exec(
            "test -f /workspace/screenshot-manifest.json && echo EXISTS",
          );
          if (check.stdout?.includes("EXISTS")) {
            manifestFound = true;
            await log("Manifest file detected.");
          } else {
            await log(
              "Agent finished but no manifest found. Waiting 5s and retrying...",
            );
            await new Promise((r) => setTimeout(r, 5_000));
            const retry = await sandbox.exec(
              "test -f /workspace/screenshot-manifest.json && echo EXISTS",
            );
            if (retry.stdout?.includes("EXISTS")) {
              manifestFound = true;
              await log("Manifest file detected on retry.");
            }
          }
          break;
        }

        // Log elapsed time every ~60s
        if (pollCount % 20 === 0) {
          const elapsed = Math.round((pollCount * 3) / 60);
          await log(`Still working... (${elapsed}m elapsed)`);
        }
      }

      if (!manifestFound) {
        await log("ERROR: Agent timed out after 10 minutes.");
        throw new Error(
          "Agent timed out after 10 minutes without producing a manifest",
        );
      }

      // Read the screenshot manifest the agent produced
      await log("Reading screenshot manifest...");
      const manifestResult = await sandbox.readFile(
        "/workspace/screenshot-manifest.json",
      );
      const manifest: ScreenshotManifest = JSON.parse(manifestResult.content);

      if (manifest.screenshots.length === 0) {
        await log("Agent produced no screenshots.");
        const octokit = createOctokit(env, job.installationId);
        await postPRComment(
          octokit,
          job.owner,
          job.repo,
          job.prNumber,
          `## Visual Diff\n\nNo screenshots were taken for commit \`${job.commitSha.slice(0, 7)}\`. The agent could not determine which pages to screenshot, or the app failed to start.`,
        );
        return;
      }

      // Upload each screenshot to R2
      await log(
        `Uploading ${manifest.screenshots.length} screenshots to R2...`,
      );
      const uploaded: UploadedScreenshot[] = [];
      for (const entry of manifest.screenshots) {
        const stream = await sandbox.readFileStream(entry.path);
        const { content } = await collectFile(stream);

        const data =
          content instanceof Uint8Array
            ? content
            : new TextEncoder().encode(content);

        const key = buildR2Key(job.owner, job.repo, job.prNumber, entry.route);
        const url = await uploadScreenshot(env, key, data);

        uploaded.push({
          route: entry.route,
          description: entry.description,
          url,
        });
        await log(`  Uploaded: ${entry.route}`);
      }

      // Post the PR comment with screenshot images
      await log("Posting PR comment...");
      const octokit = createOctokit(env, job.installationId);
      const commentBody = buildCommentMarkdown(job.commitSha, uploaded);
      await postPRComment(
        octokit,
        job.owner,
        job.repo,
        job.prNumber,
        commentBody,
      );

      await log(
        `Done! Posted ${uploaded.length} screenshots to PR #${job.prNumber}.`,
      );
      console.log(
        `Posted ${uploaded.length} screenshots to PR #${job.prNumber}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await log(`ERROR: ${message}`);
      } catch {
        // Log helper may fail if sandbox is gone
      }
      throw err;
    } finally {
      try {
        await server.close();
      } catch {
        // Best effort
      }
      try {
        await sandbox.killAllProcesses();
      } catch {
        // Best effort
      }
      try {
        await sandbox.destroy();
        console.log(`Sandbox ${job.sandboxId.slice(0, 8)} destroyed`);
      } catch {
        // Best effort
      }
    }
  };
}
