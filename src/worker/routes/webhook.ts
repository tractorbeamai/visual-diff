import { Hono } from "hono";
import {
  verifyWebhookSignature,
  createOctokit,
  reactToComment,
} from "../github";
import { createWorkflowRun } from "../utils";
import type { Env } from "../types";

const webhook = new Hono<{ Bindings: Env }>();

webhook.post("/", async (c) => {
  const body = await c.req.text();

  const signature = c.req.header("X-Hub-Signature-256") ?? "";
  const valid = await verifyWebhookSignature(
    c.env.GITHUB_WEBHOOK_SECRET,
    body,
    signature,
  );
  if (!valid) {
    return c.text("Invalid signature", 401);
  }

  const event = c.req.header("X-GitHub-Event");
  const payload = JSON.parse(body);

  // PR merged
  if (
    event === "pull_request" &&
    payload.action === "closed" &&
    payload.pull_request?.merged === true
  ) {
    const pr = payload.pull_request;
    await createWorkflowRun(c.env, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: pr.number,
      commitSha: pr.merge_commit_sha ?? pr.head.sha,
      installationId: payload.installation.id,
    });

    return c.text("Accepted", 202);
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

    const octokit = createOctokit(c.env, installationId);
    c.executionCtx.waitUntil(
      reactToComment(octokit, owner, repo, payload.comment.id, "eyes"),
    );

    const pr = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    await createWorkflowRun(c.env, {
      owner,
      repo,
      prNumber,
      commitSha: pr.data.head.sha,
      installationId,
    });

    return c.text("Accepted", 202);
  }

  return c.text("OK", 200);
});

export { webhook };
