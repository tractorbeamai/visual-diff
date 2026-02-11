/**
 * Run types shared between the worker and browser.
 * Kept in a separate file with no Cloudflare dependencies so
 * the browser tsconfig can import it without type errors.
 */

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface Run {
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  commit_sha: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
}
