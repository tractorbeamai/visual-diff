import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          compatibilityDate: "2025-05-06",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
