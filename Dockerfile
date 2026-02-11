FROM docker.io/cloudflare/sandbox:0.7.1

# Claude Agent SDK (bundles claude-code CLI), agent-browser, tsx
RUN npm install -g @anthropic-ai/claude-agent-sdk tsx agent-browser

ENV COMMAND_TIMEOUT_MS=300000
EXPOSE 3000
EXPOSE 8080
