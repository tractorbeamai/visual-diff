#!/usr/bin/env bash
set -euo pipefail

# Deployment script for visual-diff.
# Run this after completing the prerequisites below.
#
# Prerequisites (manual, one-time):
#
# 1. GitHub App
#    - Create at https://github.com/settings/apps
#    - Permissions: Contents (read), Pull requests (read+write), Issues (write), Metadata (read)
#    - Subscribe to events: pull_request, issue_comment
#    - Set webhook URL to https://vd.tractorbeam.ai/webhook
#    - Generate a private key and note the App ID
#    - Install on target repos/org
#
# 2. DNS (tractorbeam.ai zone in Cloudflare)
#    - A record:  vd.tractorbeam.ai         -> 192.0.2.0 (proxied)
#    - Wildcard:  *.vd.tractorbeam.ai       -> 192.0.2.0 (proxied)
#    - CNAME:     screenshots.tractorbeam.ai -> R2 bucket custom domain
#
# 3. R2 Bucket
#    - Create bucket: visual-diff-screenshots
#    - Enable public access via custom domain: screenshots.tractorbeam.ai
#    - Optional: add 90-day lifecycle rule for auto-cleanup
#
# 4. Cloudflare Queue
#    - Created automatically on first deploy via wrangler.jsonc
#
# 5. AI Gateway
#    - Create gateway named "visual-diff" in Cloudflare dashboard
#      (or change the AI_GATEWAY_ID var in wrangler.jsonc)
#    - The Worker uses the AI binding to resolve the gateway URL at runtime
#
# 6. Secrets (run these before first deploy):
#    wrangler secret put GITHUB_APP_ID
#    wrangler secret put GITHUB_APP_PRIVATE_KEY
#    wrangler secret put GITHUB_WEBHOOK_SECRET
#    wrangler secret put ANTHROPIC_API_KEY
#    wrangler secret put INTERNAL_SECRET

echo "Running pre-deploy checks..."

pnpm run typecheck
pnpm run lint
pnpm run test

echo "Deploying to Cloudflare..."

pnpm wrangler deploy

echo "Deploy complete. Verify at https://vd.tractorbeam.ai/health"
