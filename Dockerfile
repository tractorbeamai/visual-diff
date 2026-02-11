FROM cloudflare/sandbox:0.7.1

# Install OpenCode CLI and symlink to a system PATH location
# (ENV PATH doesn't survive the sandbox runtime overlay)
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && PATH="/root/.opencode/bin:${PATH}" bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && ln -s /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

# Install agent-browser for remote browser automation
RUN npm install -g agent-browser
