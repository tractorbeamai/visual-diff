import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs";
import { buildSystemPrompt } from "./prompt";

const cdpUrl = process.env.VD_CDP_URL!;
const previewUrl = process.env.VD_PREVIEW_URL!;
const screenshotSecret = process.env.VD_INTERNAL_SECRET!;

const screenshotTool = createSdkMcpServer({
  name: "visual-diff",
  version: "1.0.0",
  tools: [
    tool(
      "submit_screenshots",
      "Submit the screenshots you have taken to be posted on the PR. Call this once when you are done taking all screenshots.",
      {
        screenshots: z.array(
          z.object({
            path: z
              .string()
              .describe("Absolute path to the screenshot PNG file"),
            route: z
              .string()
              .describe(
                "The app route that was screenshotted (e.g. /dashboard)",
              ),
            description: z
              .string()
              .describe("Brief description of what this screenshot shows"),
          }),
        ),
      },
      async ({ screenshots }) => {
        fs.writeFileSync(
          "/workspace/screenshot-manifest.json",
          JSON.stringify({ screenshots }, null, 2),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Submitted ${screenshots.length} screenshots. They will be posted to the PR.`,
            },
          ],
        };
      },
    ),
  ],
});

const systemPrompt = buildSystemPrompt({
  cdpUrl,
  previewUrl,
  screenshotSecret,
});

async function main() {
  fs.mkdirSync("/workspace/screenshots", { recursive: true });

  for await (const message of query({
    prompt: systemPrompt,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      maxTurns: 80,
      maxBudgetUsd: 3.0,
      mcpServers: { "visual-diff": screenshotTool },
      allowedTools: [
        "mcp__visual-diff__submit_screenshots",
        "Bash",
        "Read",
        "Write",
        "Glob",
        "Grep",
      ],
    },
  })) {
    if (message.type === "result") {
      if (message.subtype !== "success") {
        console.error("Agent failed:", JSON.stringify(message));
        process.exit(1);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
