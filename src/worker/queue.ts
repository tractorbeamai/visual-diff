import {
  createOctokit,
  fetchPRDetails,
  fetchPRDiff,
  fetchChangedFiles,
} from "./github";
import { startScreenshotJob } from "./sandbox";
import { failAndCleanupSandbox } from "./cleanup";
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
      await failAndCleanupSandbox(env, job, message);
      msg.ack();
    }
  }
}

/**
 * Build a QueueMessage with pre-fetched PR metadata.
 * Only fetches the diff and changed files from GitHub.
 */
export async function buildQueueMessage(
  env: Env,
  opts: {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    installationId: number;
    prTitle: string;
    prDescription: string;
  },
): Promise<Omit<QueueMessage, "sandboxId">> {
  const octokit = createOctokit(env, opts.installationId);

  const [diff, changedFiles] = await Promise.all([
    fetchPRDiff(octokit, opts.owner, opts.repo, opts.prNumber),
    fetchChangedFiles(octokit, opts.owner, opts.repo, opts.prNumber),
  ]);

  return {
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    commitSha: opts.commitSha,
    installationId: opts.installationId,
    prTitle: opts.prTitle,
    prDescription: opts.prDescription,
    prDiff: diff,
    changedFiles,
  };
}

/**
 * Build a QueueMessage by fetching all PR details from GitHub.
 * Used when the caller doesn't already have PR metadata (e.g. comment webhook).
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
  const prDetails = await fetchPRDetails(octokit, owner, repo, prNumber);

  return buildQueueMessage(env, {
    owner,
    repo,
    prNumber,
    commitSha,
    installationId,
    prTitle: prDetails.title,
    prDescription: prDetails.body,
  });
}
