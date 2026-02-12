import { Hono } from "hono";
import {
  createOctokit,
  fetchPRDetails,
  parsePRUrl,
  lookupInstallationId,
} from "../github";
import { registerRun } from "../db";
import type { Env } from "../types";

const start = new Hono<{ Bindings: Env }>();

start.post("/", async (c) => {
  const body = (await c.req.json()) as {
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
      return c.json(
        {
          error:
            "Invalid PR URL. Expected: https://github.com/{owner}/{repo}/pull/{number}",
        },
        400,
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
    return c.json(
      { error: "Provide either 'url' or 'owner'+'repo'+'pr'" },
      400,
    );
  }

  const installationId = await lookupInstallationId(c.env, owner, repo);
  const octokit = createOctokit(c.env, installationId);
  const prDetails = await fetchPRDetails(octokit, owner, repo, prNumber);

  const sid = crypto.randomUUID();

  const { cancelledRun } = await registerRun(c.env, {
    id: sid,
    owner,
    repo,
    prNumber,
    commitSha: prDetails.headSha,
  });

  await c.env.SCREENSHOT_WORKFLOW.create({
    id: sid,
    params: {
      sandboxId: sid,
      owner,
      repo,
      prNumber,
      commitSha: prDetails.headSha,
      installationId,
    },
  });

  return c.json(
    {
      status: "accepted",
      pr: `${owner}/${repo}#${prNumber}`,
      sandboxId: sid,
      cancelledRun: cancelledRun?.id ?? null,
    },
    202,
  );
});

export { start };
