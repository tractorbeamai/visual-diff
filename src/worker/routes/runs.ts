import { Hono } from "hono";
import { listRuns, killRun } from "../db";
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

runs.post("/:id/kill", async (c) => {
  const runId = c.req.param("id");
  const found = await killRun(c.env, runId);

  if (!found) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json({ status: "killed", id: runId });
});

export { runs };
