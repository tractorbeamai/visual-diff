import { Hono } from "hono";
import { listRuns } from "../db";
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

export { runs };
