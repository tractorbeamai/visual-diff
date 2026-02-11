import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { timingSafeEqual } from "./crypto";
import type { Env, ChangedFile } from "./types";

/**
 * Create an authenticated Octokit instance for a specific installation.
 */
export function createOctokit(env: Env, installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      installationId,
    },
  });
}

/**
 * Get an installation access token for git clone operations.
 */
export async function getInstallationToken(
  env: Env,
  installationId: number,
): Promise<string> {
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId,
  });
  const { token } = await auth({ type: "installation" });
  return token;
}

/**
 * Fetch the full diff for a PR as a unified patch string.
 */
export async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  // When requesting diff format, data is a string
  return data as unknown as string;
}

/**
 * Fetch the list of changed files in a PR.
 */
export async function fetchChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for await (const response of octokit.paginate.iterator(
    octokit.pulls.listFiles,
    { owner, repo, pull_number: prNumber, per_page: 100 },
  )) {
    for (const f of response.data) {
      files.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }
  }
  return files;
}

/**
 * Fetch PR metadata (title, body, head SHA).
 */
export async function fetchPRDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ title: string; body: string; headSha: string }> {
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return {
    title: data.title,
    body: data.body ?? "",
    headSha: data.head.sha,
  };
}

/**
 * Post a comment on a PR (uses the issues API since PR comments are issue comments).
 */
export async function postPRComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

/**
 * React to a comment with an emoji (e.g. "eyes" for acknowledgment).
 */
export async function reactToComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content:
    | "+1"
    | "-1"
    | "laugh"
    | "confused"
    | "heart"
    | "hooray"
    | "rocket"
    | "eyes",
): Promise<void> {
  await octokit.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: commentId,
    content,
  });
}

/**
 * Verify a GitHub webhook signature (HMAC SHA-256).
 */
export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expected = `sha256=${arrayBufferToHex(sig)}`;
  return timingSafeEqual(expected, signature);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Look up the installation ID for a given owner/repo via the GitHub App API.
 * Used by the /trigger endpoint which doesn't have an installation_id from a webhook.
 */
export async function lookupInstallationId(
  env: Env,
  owner: string,
  repo: string,
): Promise<number> {
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
  });
  const { token } = await auth({ type: "app" });

  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.apps.getRepoInstallation({ owner, repo });
  return data.id;
}

/**
 * Parse a GitHub PR URL into its components.
 * Accepts: https://github.com/{owner}/{repo}/pull/{number}
 */
export function parsePRUrl(
  url: string,
): { owner: string; repo: string; prNumber: number } | null {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
  };
}
