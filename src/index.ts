import { proxyToSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

import { handleCDP } from "./cdp";
import {
  verifyWebhookSignature,
  createOctokit,
  fetchPRDetails,
  fetchPRDiff,
  fetchChangedFiles,
  reactToComment,
  parsePRUrl,
  lookupInstallationId,
} from "./github";
import { processScreenshotJob } from "./sandbox";
import type { Env, QueueMessage } from "./types";

// ─── Main Worker ─────────────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // CDP WebSocket + discovery endpoints
    if (url.pathname.startsWith("/cdp")) {
      return handleCDP(request, env);
    }

    // Preview URL auth gate: requests with a sandbox subdomain pattern
    // must include the X-Screenshot-Auth header.
    if (isPreviewRequest(url)) {
      const authHeader = request.headers.get("X-Screenshot-Auth");
      if (authHeader !== env.INTERNAL_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // Proxy preview URL traffic to sandbox (returns null if not a preview request)
    const proxy = await proxyToSandbox(request, env);
    if (proxy) return proxy;

    // GitHub webhook handler (PR merge + @visual-diff comment)
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }

    // Manual trigger endpoint
    if (url.pathname === "/trigger" && request.method === "POST") {
      return handleTrigger(request, env);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", service: "visual-diff" });
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processScreenshotJob(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error("Queue job failed:", err);
        msg.retry();
      }
    }
  },
};

// ─── Webhook handler ─────────────────────────────────────────────────────────

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.text();

  // Verify webhook signature
  const signature = request.headers.get("X-Hub-Signature-256") ?? "";
  const valid = await verifyWebhookSignature(
    env.GITHUB_WEBHOOK_SECRET,
    body,
    signature,
  );
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = request.headers.get("X-GitHub-Event");
  const payload = JSON.parse(body);

  // PR merged
  if (
    event === "pull_request" &&
    payload.action === "closed" &&
    payload.pull_request?.merged === true
  ) {
    const message = await buildQueueMessage(env, payload, payload.pull_request);
    await env.SCREENSHOT_QUEUE.send(message);
    return new Response("Accepted", { status: 202 });
  }

  // @visual-diff comment on a PR
  if (
    event === "issue_comment" &&
    payload.action === "created" &&
    payload.issue?.pull_request &&
    payload.comment?.body?.includes("@visual-diff")
  ) {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.issue.number;
    const installationId = payload.installation.id;

    // React with eyes to acknowledge (fire and forget)
    const octokit = createOctokit(env, installationId);
    ctx.waitUntil(
      reactToComment(octokit, owner, repo, payload.comment.id, "eyes"),
    );

    // Fetch PR details to get the head SHA
    const pr = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const message = await buildQueueMessageFromPR(
      env,
      owner,
      repo,
      prNumber,
      pr.data.head.sha,
      installationId,
    );
    await env.SCREENSHOT_QUEUE.send(message);
    return new Response("Accepted", { status: 202 });
  }

  // Unhandled event -- that's fine, just acknowledge
  return new Response("OK", { status: 200 });
}

// ─── Trigger endpoint ────────────────────────────────────────────────────────

async function handleTrigger(request: Request, env: Env): Promise<Response> {
  // Verify bearer token
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${env.INTERNAL_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    url?: string;
    owner?: string;
    repo?: string;
    pr?: number;
  };

  let owner: string;
  let repo: string;
  let prNumber: number;

  if (body.url) {
    const parsed = parsePRUrl(body.url);
    if (!parsed) {
      return Response.json(
        {
          error:
            "Invalid PR URL. Expected: https://github.com/{owner}/{repo}/pull/{number}",
        },
        { status: 400 },
      );
    }
    owner = parsed.owner;
    repo = parsed.repo;
    prNumber = parsed.prNumber;
  } else if (body.owner && body.repo && body.pr) {
    owner = body.owner;
    repo = body.repo;
    prNumber = body.pr;
  } else {
    return Response.json(
      { error: "Provide either 'url' or 'owner'+'repo'+'pr'" },
      { status: 400 },
    );
  }

  // Look up installation for this repo
  const installationId = await lookupInstallationId(env, owner, repo);
  const octokit = createOctokit(env, installationId);

  // Fetch PR details
  const prDetails = await fetchPRDetails(octokit, owner, repo, prNumber);

  const message = await buildQueueMessageFromPR(
    env,
    owner,
    repo,
    prNumber,
    prDetails.headSha,
    installationId,
  );
  await env.SCREENSHOT_QUEUE.send(message);

  return Response.json(
    { status: "accepted", pr: `${owner}/${repo}#${prNumber}` },
    { status: 202 },
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Detect if a request is for a sandbox preview URL (subdomain-based routing).
 * Preview URLs look like: https://8080-sandbox-id-token.vd.tractorbeam.ai/...
 */
function isPreviewRequest(url: URL): boolean {
  const host = url.hostname;
  // Preview URLs are subdomains of vd.tractorbeam.ai that contain port info
  return host.endsWith(".vd.tractorbeam.ai") && host !== "vd.tractorbeam.ai";
}

/**
 * Build a QueueMessage from a pull_request webhook payload.
 */
async function buildQueueMessage(
  env: Env,
  payload: {
    repository: { owner: { login: string }; name: string };
    installation: { id: number };
  },
  pr: {
    number: number;
    title: string;
    body: string | null;
    merge_commit_sha?: string | null;
    head: { sha: string };
  },
): Promise<QueueMessage> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const installationId = payload.installation.id;
  const commitSha = pr.merge_commit_sha ?? pr.head.sha;

  return buildQueueMessageFromPR(
    env,
    owner,
    repo,
    pr.number,
    commitSha,
    installationId,
  );
}

async function buildQueueMessageFromPR(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  installationId: number,
): Promise<QueueMessage> {
  const octokit = createOctokit(env, installationId);

  const [prDetails, diff, changedFiles] = await Promise.all([
    fetchPRDetails(octokit, owner, repo, prNumber),
    fetchPRDiff(octokit, owner, repo, prNumber),
    fetchChangedFiles(octokit, owner, repo, prNumber),
  ]);

  return {
    owner,
    repo,
    prNumber,
    commitSha,
    installationId,
    prTitle: prDetails.title,
    prDescription: prDetails.body,
    prDiff: diff,
    changedFiles,
  };
}
