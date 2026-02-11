import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../types";

const stream = new Hono<{ Bindings: Env }>();

/**
 * Wait for the sandbox container to be reachable, retrying with backoff.
 * The /start route enqueues a job and returns the sandbox ID immediately,
 * but the container may not be booted yet when the frontend connects here.
 *
 * Each exec attempt has its own timeout (sandbox.exec can hang indefinitely
 * if the container doesn't exist yet). Total time is kept under 20s to stay
 * within the Worker's ~30s wall-clock limit.
 */
async function waitForSandbox(
  sandbox: ReturnType<typeof getSandbox>,
  maxWaitMs = 20_000,
) {
  const start = Date.now();
  let delay = 500;
  while (Date.now() - start < maxWaitMs) {
    try {
      await Promise.race([
        sandbox.exec("true"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("exec timeout")), 5_000),
        ),
      ]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 2_000);
    }
  }
  throw new Error("Sandbox not reachable after " + maxWaitMs + "ms");
}

stream.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  try {
    await waitForSandbox(sandbox);
  } catch {
    return c.json({ error: "Sandbox not ready" }, 503);
  }

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
