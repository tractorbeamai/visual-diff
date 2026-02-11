import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../types";

const logs = new Hono<{ Bindings: Env }>();

logs.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  try {
    const result = await Promise.race([
      sandbox.exec("cat /workspace/agent.log 2>/dev/null || true"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("exec timeout")), 5_000),
      ),
    ]);

    const lines = (result.stdout ?? "").split("\n").filter(Boolean);

    return c.json({ lines });
  } catch {
    // Sandbox not reachable yet -- return empty
    return c.json({ lines: [] });
  }
});

export { logs };
