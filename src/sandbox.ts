import { getSandbox, collectFile } from "@cloudflare/sandbox";
import type { Env, QueueMessage, ScreenshotManifest, UploadedScreenshot } from "./types";
import { AGENT_RUNNER_SCRIPT } from "./agent";
import {
  buildR2Key,
  uploadScreenshot,
  buildCommentMarkdown,
} from "./storage";
import {
  createOctokit,
  getInstallationToken,
  postPRComment,
} from "./github";

/**
 * Process a screenshot job: spin up sandbox, run agent, upload screenshots, post comment.
 */
export async function processScreenshotJob(
  job: QueueMessage,
  env: Env,
): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, crypto.randomUUID().slice(0, 8));

  try {
    // Get installation token for git clone
    const token = await getInstallationToken(env, job.installationId);

    // Clone the repo at the target commit
    await sandbox.gitCheckout(
      `https://x-access-token:${token}@github.com/${job.owner}/${job.repo}.git`,
      { targetDir: "repo" },
    );
    await sandbox.exec(`git checkout ${job.commitSha}`, { cwd: "/workspace/repo" });

    // Set environment variables for the agent (AI Gateway routing + config)
    await sandbox.setEnvVars({
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    });

    // Write PR context files for the agent to read
    await sandbox.exec("mkdir -p /workspace/context");
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
    const exposed = await sandbox.exposePort(8080, {
      hostname: "vd.tractorbeam.ai",
    });

    // Pass agent config as environment variables (read by the pre-built runner)
    await sandbox.setEnvVars({
      VD_CDP_URL: `wss://vd.tractorbeam.ai/cdp?secret=${env.CDP_SECRET}`,
      VD_PREVIEW_URL: exposed.url,
      VD_SCREENSHOT_SECRET: env.SCREENSHOT_SECRET,
    });

    // Write the pre-built agent runner script and execute it
    await sandbox.writeFile("/workspace/run-agent.js", AGENT_RUNNER_SCRIPT);

    // Run the agent (5-minute timeout) -- .js since it's pre-bundled, no tsx needed
    const result = await sandbox.exec("node /workspace/run-agent.js", {
      timeout: 300_000,
      cwd: "/workspace",
    });

    if (!result.success) {
      console.error("Agent failed:", result.stderr);
      throw new Error(`Agent exited with code ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
    }

    // Read the screenshot manifest the agent produced
    const manifestResult = await sandbox.readFile("/workspace/screenshot-manifest.json");
    const manifest: ScreenshotManifest = JSON.parse(manifestResult.content);

    if (manifest.screenshots.length === 0) {
      console.log("Agent produced no screenshots");
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
    const uploaded: UploadedScreenshot[] = [];
    for (const entry of manifest.screenshots) {
      const stream = await sandbox.readFileStream(entry.path);
      const { content } = await collectFile(stream);

      // content is Uint8Array for binary files
      const data = content instanceof Uint8Array
        ? content
        : new TextEncoder().encode(content);

      const key = buildR2Key(job.owner, job.repo, job.prNumber, entry.route);
      const url = await uploadScreenshot(env, key, data);

      uploaded.push({
        route: entry.route,
        description: entry.description,
        url,
      });
    }

    // Post the PR comment with screenshot images
    const octokit = createOctokit(env, job.installationId);
    const commentBody = buildCommentMarkdown(job.commitSha, uploaded);
    await postPRComment(octokit, job.owner, job.repo, job.prNumber, commentBody);

    console.log(`Posted ${uploaded.length} screenshots to PR #${job.prNumber}`);
  } finally {
    // Clean up: unexpose port and let the sandbox be garbage collected
    try {
      await sandbox.unexposePort(8080);
    } catch {
      // Sandbox may already be destroyed
    }
  }
}
