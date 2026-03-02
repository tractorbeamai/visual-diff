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

  console.log(`[messages] Fetching for sandbox ${id}`);
  const sandbox = getSandbox(c.env.Sandbox, id);

  // Try the live sandbox first
  try {
    // Read session metadata written by the workflow's start-agent step
    console.log(`[messages] Reading opencode-session.json...`);
    const file = await withTimeout(
      sandbox.readFile("/workspace/opencode-session.json"),
      5_000,
    );
    console.log(`[messages] Got file content: ${file.content}`);
    const meta = JSON.parse(file.content as string);
    const sessionId: string = meta.sessionId;
    const directory: string = meta.directory;
    console.log(`[messages] Session: ${sessionId}, directory: ${directory}`);

    // Connect to the already-running OpenCode server (reuses existing process)
    console.log(`[messages] Creating opencode client...`);
    const { client, server } = await createOpencode<OpencodeClient>(sandbox, {
      directory,
    });
    console.log(`[messages] OpenCode client created`);

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

      // Log full results for debugging
      console.log(`[messages] msgsResult:`, JSON.stringify(msgsResult));
      console.log(`[messages] statusResult:`, JSON.stringify(statusResult));

      if (msgsResult.error) {
        // Return error in response for debugging
        return c.json({
          messages: [],
          status: null,
          debug: {
            error: "messages_api_error",
            detail: msgsResult.error,
            sessionId,
            directory,
          },
        });
      }

      const msgs = msgsResult.data ?? [];
      const statuses = statusResult.data as
        | Record<string, { type: string }>
        | undefined;
      const sessionStatus = statuses?.[sessionId] ?? null;

      return c.json({
        messages: msgs,
        status: sessionStatus,
        debug: {
          sessionId,
          directory,
          messageCount: msgs.length,
          statusResult: statusResult.data,
        },
      });
    } finally {
      await server.close();
    }
  } catch (err) {
    // Return error in response for debugging instead of silently falling through
    const errorMsg = err instanceof Error ? err.message : String(err);
    return c.json({
      messages: [],
      status: null,
      debug: {
        error: "sandbox_fetch_failed",
        detail: errorMsg,
        sandboxId: id,
      },
    });
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
