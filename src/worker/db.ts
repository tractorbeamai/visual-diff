import { getSandbox } from "@cloudflare/sandbox";
import type { Env, Run, RunStatus } from "./types";

/**
 * Register a new run for a PR. If there's already an active run (queued or
 * running) for the same PR, cancel it and destroy its sandbox.
 *
 * Returns the cancelled run (if any) so callers can log it.
 */
export async function registerRun(
  env: Env,
  run: {
    id: string;
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
  },
): Promise<{ cancelledRun: Run | null }> {
  // Find any active run for this PR
  const existing = await env.DB.prepare(
    `SELECT * FROM runs
     WHERE owner = ? AND repo = ? AND pr_number = ? AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(run.owner, run.repo, run.prNumber)
    .first<Run>();

  let cancelledRun: Run | null = null;

  if (existing) {
    // Mark the old run as cancelled
    await env.DB.prepare(
      `UPDATE runs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(existing.id)
      .run();

    // Best-effort destroy the old sandbox
    try {
      const sandbox = getSandbox(env.Sandbox, existing.id);
      await sandbox.destroy();
      console.log(
        `Cancelled run ${existing.id.slice(0, 8)} for ${run.owner}/${run.repo}#${run.prNumber}`,
      );
    } catch {
      // Sandbox may already be gone
    }

    cancelledRun = existing;
  }

  // Insert the new run
  await env.DB.prepare(
    `INSERT INTO runs (id, owner, repo, pr_number, commit_sha, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`,
  )
    .bind(run.id, run.owner, run.repo, run.prNumber, run.commitSha)
    .run();

  return { cancelledRun };
}

/**
 * Look up a single run by ID. Returns null if not found.
 */
export async function getRun(
  db: D1Database,
  runId: string,
): Promise<Run | null> {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first<Run>();
}

/**
 * Check if a run is still the active one (not cancelled/superseded).
 */
export async function isRunActive(
  db: D1Database,
  runId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT status FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ status: RunStatus }>();
  return row?.status === "queued" || row?.status === "running";
}

/**
 * Transition a run to a new status. Only updates if the run hasn't already
 * been cancelled (avoids overwriting a cancellation).
 */
export async function updateRunStatus(
  db: D1Database,
  runId: string,
  status: RunStatus,
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET status = ?, updated_at = datetime('now')
       WHERE id = ? AND status NOT IN ('cancelled', 'completed', 'failed')`,
    )
    .bind(status, runId)
    .run();
}

/**
 * Force-kill a run: mark it failed in D1 and destroy its sandbox DO.
 * Returns true if a run was found and updated.
 */
export async function killRun(env: Env, runId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT status FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ status: string }>();

  if (!row) return false;

  // Update status to failed (even if already terminal -- force it)
  await env.DB.prepare(
    `UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(runId)
    .run();

  // Best-effort destroy the sandbox DO
  try {
    const sandbox = getSandbox(env.Sandbox, runId);
    await sandbox.destroy();
    console.log(`Sandbox ${runId.slice(0, 8)} destroyed via kill`);
  } catch {
    // Sandbox may already be gone
  }

  return true;
}

/**
 * List runs, optionally filtered by owner/repo/PR.
 */
export async function listRuns(
  db: D1Database,
  filters?: {
    owner?: string;
    repo?: string;
    prNumber?: number;
    status?: RunStatus;
  },
  limit = 50,
): Promise<Run[]> {
  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  if (filters?.owner) {
    conditions.push("owner = ?");
    binds.push(filters.owner);
  }
  if (filters?.repo) {
    conditions.push("repo = ?");
    binds.push(filters.repo);
  }
  if (filters?.prNumber) {
    conditions.push("pr_number = ?");
    binds.push(filters.prNumber);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    binds.push(filters.status);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  binds.push(limit);

  const { results } = await db
    .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds)
    .all<Run>();

  return results;
}
