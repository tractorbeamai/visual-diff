import { getSandbox } from "@cloudflare/sandbox";
import {
  createOctokit,
  fetchPRDetails,
  fetchPRDiff,
  fetchChangedFiles,
} from "./github";
import { startScreenshotJob } from "./sandbox";
import { isRunActive, updateRunStatus } from "./db";
import type { Env, QueueMessage } from "./types";

/**
 * Queue consumer -- processes screenshot jobs from the queue.
 */
export async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body;
    try {
      // Skip if this run was already cancelled (superseded by a newer run)
      const active = await isRunActive(env.DB, job.sandboxId);
      if (!active) {
        console.log(`Run ${job.sandboxId.slice(0, 8)} was cancelled, skipping`);
        msg.ack();
        continue;
      }

      await updateRunStatus(env.DB, job.sandboxId, "running");
      const cleanup = await startScreenshotJob(job, env);
      msg.ack();
      ctx.waitUntil(cleanup());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Queue job failed during setup:", err);

      // Mark the run as failed in D1
      try {
        await updateRunStatus(env.DB, job.sandboxId, "failed");
      } catch {
        // Best effort
      }

      // Best-effort: write error to the sandbox log
      try {
        const sandbox = getSandbox(env.Sandbox, job.sandboxId);
        const ts = new Date().toISOString();
        const clean = message
          .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
          .replace(/'/g, "'\\''");
        await sandbox.exec(
          `echo '${ts} ERROR: Job failed -- ${clean}'  >> /workspace/agent.log`,
        );
      } catch {
        // Sandbox may not be reachable
      }

      // Destroy sandbox on setup failure
      try {
        const sandbox = getSandbox(env.Sandbox, job.sandboxId);
        await sandbox.destroy();
        console.log(
          `Sandbox ${job.sandboxId.slice(0, 8)} destroyed after failure`,
        );
      } catch {
        // Best effort
      }

      // No retries -- ack and move on
      msg.ack();
    }
  }
}

/**
 * Build a QueueMessage from a pull_request webhook payload.
 */
export async function buildQueueMessage(
  env: Env,
  payload: {
    repository: { owner: { login: string }; name: string };
    installation: { id: number };
  },
  pr: {
    number: number;
    title: string;
    body: string | null;
    merge_commit_sha?: string | null;
    head: { sha: string };
  },
): Promise<Omit<QueueMessage, "sandboxId">> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const installationId = payload.installation.id;
  const commitSha = pr.merge_commit_sha ?? pr.head.sha;

  return buildQueueMessageFromPR(
    env,
    owner,
    repo,
    pr.number,
    commitSha,
    installationId,
  );
}

/**
 * Build a QueueMessage by fetching PR details from GitHub.
 * Shared by webhook and start routes.
 */
export async function buildQueueMessageFromPR(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  installationId: number,
): Promise<Omit<QueueMessage, "sandboxId">> {
  const octokit = createOctokit(env, installationId);

  const [prDetails, diff, changedFiles] = await Promise.all([
    fetchPRDetails(octokit, owner, repo, prNumber),
    fetchPRDiff(octokit, owner, repo, prNumber),
    fetchChangedFiles(octokit, owner, repo, prNumber),
  ]);

  return {
    owner,
    repo,
    prNumber,
    commitSha,
    installationId,
    prTitle: prDetails.title,
    prDescription: prDetails.body,
    prDiff: diff,
    changedFiles,
  };
}
