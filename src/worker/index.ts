import { Hono } from "hono";
import { proxyToSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

import { handleCDP } from "./cdp";
import { handleQueue } from "./queue";
import { webhook } from "./routes/webhook";
import { start } from "./routes/start";
import { stream } from "./routes/stream";
import type { Env } from "./types";

// ─── Hono App ─────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// Middleware: proxy preview URL traffic to sandbox (subdomain-based routing)
app.use("*", async (c, next) => {
  const proxy = await proxyToSandbox(c.req.raw, c.env);
  if (proxy) return proxy;
  return next();
});

// Middleware: preview URL auth gate

function isPreviewRequest(url: URL): boolean {
  const host = url.hostname;
  return host.endsWith(".vd.tractorbeam.ai") && host !== "vd.tractorbeam.ai";
}

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (isPreviewRequest(url)) {
    const authHeader = c.req.header("X-Screenshot-Auth");
    if (authHeader !== c.env.INTERNAL_SECRET) {
      return c.text("Forbidden", 403);
    }
  }
  return next();
});

// CDP WebSocket + discovery endpoints
app.all("/cdp/*", (c) => handleCDP(c.req.raw, c.env));
app.all("/cdp", (c) => handleCDP(c.req.raw, c.env));

// Routes
app.route("/webhook", webhook);
app.route("/start", start);
app.route("/stream", stream);

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "visual-diff" }));

export default {
  fetch: app.fetch,
  queue: handleQueue,
};
