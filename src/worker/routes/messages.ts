import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { getMessagesFromR2 } from "../storage";
import { getRun } from "../db";
import { withTimeout } from "../utils";
import type { Env } from "../types";

const messages = new Hono<{ Bindings: Env }>();

messages.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  // Try the live sandbox first
  try {
    // Read session metadata written by the workflow's start-agent step
    const file = await withTimeout(
      sandbox.readFile("/workspace/opencode-session.json"),
      5_000,
    );
    const meta = JSON.parse(file.content as string);
    const sessionId: string = meta.sessionId;
    const directory: string = meta.directory;

    // Connect to the already-running OpenCode server (reuses existing process)
    const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
      directory,
    });

    try {
      const [msgsResult, statusResult] = await Promise.all([
        client.session.messages({
          path: { id: sessionId },
          query: { directory },
        }),
        client.session.status({
          query: { directory },
        }),
      ]);

      const msgs = msgsResult.data ?? [];
      const statuses = statusResult.data as
        | Record<string, { type: string }>
        | undefined;
      const sessionStatus = statuses?.[sessionId] ?? null;

      return c.json({ messages: msgs, status: sessionStatus });
    } finally {
      await server.close();
    }
  } catch {
    // Sandbox not reachable -- fall back to R2
  }

  // Fall back to persisted messages in R2
  try {
    const run = await getRun(c.env.DB, id);
    if (run) {
      const persisted = await getMessagesFromR2(c.env, run.owner, run.repo, id);
      if (persisted) {
        return c.json({ messages: persisted, status: null });
      }
    }
  } catch (err) {
    console.error("R2 messages fallback failed:", err);
  }

  return c.json({ messages: [], status: null });
});

export { messages };
