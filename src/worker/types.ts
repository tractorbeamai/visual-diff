import type { Sandbox as SandboxDO } from "@cloudflare/sandbox";

/**
 * Worker environment -- extends the generated Cloudflare.Env with secrets
 * and properly-typed bindings.
 *
 * We override the Sandbox binding with the correct type parameter since
 * the wrangler-generated types don't know the Sandbox class generic.
 */
export interface Env extends Omit<Cloudflare.Env, "Sandbox"> {
  Sandbox: DurableObjectNamespace<SandboxDO>;
  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  INTERNAL_SECRET: string;
}

/**
 * Message enqueued for the screenshot worker to process.
 * All three triggers (merge webhook, @visual-diff comment, /trigger API)
 * produce the same message shape.
 */
export interface QueueMessage {
  sandboxId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  installationId: number;
  prTitle: string;
  prDescription: string;
  prDiff: string;
  changedFiles: ChangedFile[];
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Written by the agent's submit_screenshots tool to /workspace/screenshot-manifest.json.
 * Read by the Worker after the agent exits.
 */
export interface ScreenshotManifest {
  screenshots: ScreenshotEntry[];
}

export interface ScreenshotEntry {
  /** Absolute path to the PNG file in the sandbox */
  path: string;
  /** The app route that was screenshotted, e.g. "/dashboard" */
  route: string;
  /** Brief description of what this screenshot shows */
  description: string;
}

/**
 * Result of uploading screenshots to R2 -- used to build the PR comment.
 */
export interface UploadedScreenshot {
  route: string;
  description: string;
  url: string;
}
