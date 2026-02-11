import { Hono } from "hono";
import {
  createOctokit,
  fetchPRDetails,
  parsePRUrl,
  lookupInstallationId,
} from "../github";
import { buildQueueMessageFromPR } from "../queue";
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
  const message = await buildQueueMessageFromPR(
    c.env,
    owner,
    repo,
    prNumber,
    prDetails.headSha,
    installationId,
  );
  await c.env.SCREENSHOT_QUEUE.send({ ...message, sandboxId: sid });

  return c.json(
    {
      status: "accepted",
      pr: `${owner}/${repo}#${prNumber}`,
      sandboxId: sid,
    },
    202,
  );
});

export { start };
