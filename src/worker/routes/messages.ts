import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Env } from "../types";

const messages = new Hono<{ Bindings: Env }>();

messages.get("/", async (c) => {
  const id = c.req.query("id");

  if (!id) {
    return c.json({ error: "Missing id query param" }, 400);
  }

  const sandbox = getSandbox(c.env.Sandbox, id);

  // Read session metadata written by startScreenshotJob
  let sessionId: string;
  let directory: string;
  try {
    const file = await sandbox.readFile("/workspace/opencode-session.json");
    const meta = JSON.parse(file.content as string);
    sessionId = meta.sessionId;
    directory = meta.directory;
  } catch {
    // Session file doesn't exist yet -- still in setup phase
    return c.json({ messages: [], status: null });
  }

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
});

export { messages };
