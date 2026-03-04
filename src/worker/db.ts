import { getSandbox } from "@cloudflare/sandbox";
import type { Env, Run, RunStatus } from "./types";
import { bestEffort } from "./utils";

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
      `UPDATE runs SET status = 'terminated', updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(existing.id)
      .run();

    await bestEffort(async () => {
      const instance = await env.SCREENSHOT_WORKFLOW.get(existing.id);
      await instance.terminate();
    });

    await bestEffort(async () => {
      const sandbox = getSandbox(env.Sandbox, existing.id);
      await sandbox.destroy();
    });

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
  error?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET status = ?, error = ?, updated_at = datetime('now')
       WHERE id = ? AND status NOT IN ('terminated', 'complete', 'errored')`,
    )
    .bind(status, error ?? null, runId)
    .run();
}

/**
 * Force-kill a run: mark it failed in D1, terminate its workflow, and
 * destroy its sandbox DO.
 * Returns true if a run was found and updated.
 */
export async function killRun(env: Env, runId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT status FROM runs WHERE id = ?`)
    .bind(runId)
    .first<{ status: string }>();

  if (!row) return false;

  await env.DB.prepare(
    `UPDATE runs SET status = 'errored', updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(runId)
    .run();

  await bestEffort(async () => {
    const instance = await env.SCREENSHOT_WORKFLOW.get(runId);
    await instance.terminate();
  });

  await bestEffort(async () => {
    const sandbox = getSandbox(env.Sandbox, runId);
    await sandbox.destroy();
  });

  return true;
}

/**
 * Find runs stuck in "queued" or "running" for longer than the given
 * threshold and force-fail them, terminating their workflows and sandboxes.
 */
export async function cleanupStaleRuns(
  env: Env,
  staleMinutes = 30,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM runs
     WHERE status IN ('queued', 'running')
       AND updated_at < datetime('now', ? || ' minutes')
     LIMIT 50`,
  )
    .bind(-staleMinutes)
    .all<{ id: string }>();

  for (const row of results) {
    await killRun(env, row.id);
  }

  return results.length;
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

const TERMINAL_WORKFLOW_STATUSES = new Set(["complete", "errored", "terminated"]);
const RECONCILE_GRACE_MS = 60_000;

/**
 * Reconcile D1 run status with actual workflow instance status.
 * For any run that D1 thinks is active (queued/running), check the real
 * workflow status and update D1 if the workflow has already finished.
 * This handles external terminations, sandbox deaths, and deploy resets.
 *
 * Runs younger than RECONCILE_GRACE_MS are skipped to avoid racing
 * with workflow creation (D1 row is inserted before the workflow is
 * fully queryable).
 */
export async function reconcileActiveRuns(
  env: Env,
  runs: Run[],
): Promise<Run[]> {
  const now = Date.now();
  const active = runs.filter((r) => {
    if (r.status !== "queued" && r.status !== "running") return false;
    const age = now - new Date(r.updated_at + "Z").getTime();
    return age > RECONCILE_GRACE_MS;
  });
  if (active.length === 0) return runs;

  const reconciled = await Promise.all(
    active.map(async (run) => {
      try {
        const instance = await env.SCREENSHOT_WORKFLOW.get(run.id);
        const wf = await instance.status();
        if (TERMINAL_WORKFLOW_STATUSES.has(wf.status)) {
          const status = wf.status as RunStatus;
          const error = extractWorkflowError(wf);
          await bestEffort(() =>
            updateRunStatus(env.DB, run.id, status, error ?? undefined),
          );
          return { ...run, status, error };
        }
      } catch {
        // Transient failure or instance not yet available -- leave as-is.
        // The cleanupStaleRuns cron handles truly orphaned runs.
      }
      return run;
    }),
  );

  const reconciledMap = new Map(reconciled.map((r) => [r.id, r]));
  return runs.map((r) => reconciledMap.get(r.id) ?? r);
}

function extractWorkflowError(wf: InstanceStatus): string | null {
  if (wf.error) {
    return typeof wf.error === "object" && "message" in wf.error
      ? String((wf.error as { message: unknown }).message)
      : String(wf.error);
  }
  if (wf.status === "errored") return "Workflow errored (no details available)";
  if (wf.status === "terminated") return "Workflow was terminated";
  return null;
}
