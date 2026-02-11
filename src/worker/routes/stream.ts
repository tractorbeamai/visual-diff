import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../types";

const stream = new Hono<{ Bindings: Env }>();

stream.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  // Ensure the log file exists
  await sandbox.exec("touch /workspace/agent.log");

  // Stream the log file as SSE
  const logStream = await sandbox.execStream(
    "tail -n +1 -f /workspace/agent.log",
  );

  return new Response(logStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export { stream };
