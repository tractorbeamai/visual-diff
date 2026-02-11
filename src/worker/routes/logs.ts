import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import { getLogsFromR2 } from "../storage";
import { getRun } from "../db";
import type { Env } from "../types";

const logs = new Hono<{ Bindings: Env }>();

logs.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  // Try the live sandbox first
  try {
    const result = await Promise.race([
      sandbox.exec("cat /workspace/agent.log 2>/dev/null || true"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("exec timeout")), 5_000),
      ),
    ]);

    const lines = (result.stdout ?? "").split("\n").filter(Boolean);

    // If the sandbox returned actual content, use it. An empty result likely
    // means the sandbox is in a zombie state (destroyed but stub still
    // responds) -- fall through to R2 instead of returning nothing.
    if (lines.length > 0) {
      return c.json({ lines });
    }
  } catch {
    // Sandbox not reachable -- fall through to R2
  }

  // Fall back to persisted logs in R2
  try {
    const run = await getRun(c.env.DB, id);
    if (run) {
      const persisted = await getLogsFromR2(c.env, run.owner, run.repo, id);
      if (persisted) {
        const lines = persisted.split("\n").filter(Boolean);
        return c.json({ lines });
      }
    }
  } catch (err) {
    console.error("R2 log fallback failed:", err);
  }

  return c.json({ lines: [] });
});

export { logs };
