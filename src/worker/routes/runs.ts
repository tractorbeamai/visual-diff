import { Hono } from "hono";
import { listRuns, killRun, killAllActiveRuns } from "../db";
import type { Env, RunStatus } from "../types";

const runs = new Hono<{ Bindings: Env }>();

runs.get("/", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const pr = c.req.query("pr");
  const status = c.req.query("status") as RunStatus | undefined;

  const results = await listRuns(
    c.env.DB,
    {
      owner: owner || undefined,
      repo: repo || undefined,
      prNumber: pr ? Number(pr) : undefined,
      status,
    },
    50,
  );

  return c.json({ runs: results });
});

/**
 * Kill by ID at any level:
 *   - runs: D1 run UUIDs (marks failed + destroys sandbox)
 *   - durableObjects: raw DO hex IDs (destroys DO directly)
 *   - all: kill every queued/running run in D1
 */
runs.post("/kill", async (c) => {
  const body = await c.req.json<{
    runs?: string[];
    durableObjects?: string[];
    all?: boolean;
  }>();

  const results: { id: string; type: string; status: string }[] = [];

  // Kill D1-tracked runs by UUID
  if (body.runs) {
    for (const id of body.runs) {
      const found = await killRun(c.env, id);
      results.push({
        id,
        type: "run",
        status: found ? "killed" : "not_found",
      });
    }
  }

  // Kill raw Durable Objects by hex ID
  if (body.durableObjects) {
    const ns = c.env.Sandbox;
    for (const id of body.durableObjects) {
      try {
        const stub = ns.get(ns.idFromString(id));
        await stub.fetch(
          new Request("https://sandbox/destroy", { method: "POST" }),
        );
        results.push({ id, type: "durable_object", status: "destroyed" });
      } catch (e) {
        results.push({
          id,
          type: "durable_object",
          status: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Kill all active runs in D1
  if (body.all) {
    const killed = await killAllActiveRuns(c.env);
    results.push({
      id: "*",
      type: "all_active",
      status: `killed ${killed} runs`,
    });
  }

  return c.json({ results });
});

runs.post("/:id/kill", async (c) => {
  const runId = c.req.param("id");
  const found = await killRun(c.env, runId);

  if (!found) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json({ status: "killed", id: runId });
});

export { runs };
