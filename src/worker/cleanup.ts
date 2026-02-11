import { getSandbox } from "@cloudflare/sandbox";
import { updateRunStatus } from "./db";
import { syncLogsToR2 } from "./storage";
import type { Env, QueueMessage } from "./types";

/**
 * Sanitize a string by masking git access tokens.
 */
function sanitize(msg: string): string {
  return msg
    .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
    .replace(/'/g, "'\\''");
}

/**
 * Best-effort cleanup after a job fails during setup:
 * 1. Mark the run as failed in D1
 * 2. Write the error to the sandbox log and flush to R2
 * 3. Destroy the sandbox
 */
export async function failAndCleanupSandbox(
  env: Env,
  job: QueueMessage,
  errorMessage: string,
): Promise<void> {
  try {
    await updateRunStatus(env.DB, job.sandboxId, "failed");
  } catch {
    // Best effort
  }

  const sandbox = getSandbox(env.Sandbox, job.sandboxId);

  // Write error to sandbox log and flush to R2
  try {
    const ts = new Date().toISOString();
    const clean = sanitize(errorMessage);
    await sandbox.exec(
      `echo '${ts} ERROR: Job failed -- ${clean}'  >> /workspace/agent.log`,
    );
    const logResult = await sandbox.exec(
      "cat /workspace/agent.log 2>/dev/null || true",
    );
    const logContent = logResult.stdout ?? "";
    if (logContent.trim()) {
      await syncLogsToR2(env, job.owner, job.repo, job.sandboxId, logContent);
    }
  } catch {
    // Sandbox may not be reachable
  }

  // Destroy the sandbox
  try {
    await sandbox.destroy();
    console.log(`Sandbox ${job.sandboxId.slice(0, 8)} destroyed after failure`);
  } catch {
    // Best effort
  }
}
