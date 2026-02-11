import { defineConfig } from "rolldown";

export default defineConfig({
  input: "./sandbox-agent/runner.ts",
  output: {
    file: "dist/runner.mjs",
    format: "esm",
  },
  platform: "node",
  external: [/^@anthropic-ai\//],
});
