import { registerRun } from "./db";
import type { Env, Run } from "./types";

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

export async function bestEffort<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export async function createWorkflowRun(
  env: Env,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    installationId: number;
  },
): Promise<{ sandboxId: string; cancelledRun: Run | null }> {
  const sandboxId = crypto.randomUUID();

  const { cancelledRun } = await registerRun(env, {
    id: sandboxId,
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    commitSha: params.commitSha,
  });

  await env.SCREENSHOT_WORKFLOW.create({
    id: sandboxId,
    params: {
      sandboxId,
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      commitSha: params.commitSha,
      installationId: params.installationId,
    },
    retention: {
      successRetention: "1 day",
      errorRetention: "3 days",
    },
  });

  return { sandboxId, cancelledRun };
}
