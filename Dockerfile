FROM docker:dind-rootless

USER root

# Copy sandbox binary and required shared libraries (musl build for Alpine)
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /container-server/sandbox /sandbox
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /bin/bash /bin/bash
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libreadline.so.8 /usr/lib/libreadline.so.8
COPY --from=docker.io/cloudflare/sandbox:0.7.4-musl /usr/lib/libreadline.so.8.2 /usr/lib/libreadline.so.8.2

# System packages needed by target repos the agent will build
RUN apk add --no-cache \
    nodejs \
    npm \
    curl \
    git \
    bash \
    build-base \
    python3 \
    py3-pip

# Install OpenCode CLI and symlink to a system PATH location
# (ENV PATH doesn't survive the sandbox runtime overlay)
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && PATH="/root/.opencode/bin:${PATH}" bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && ln -s /root/.opencode/bin/opencode /usr/local/bin/opencode \
    && opencode --version

# Install agent-browser for remote browser automation
RUN npm install -g agent-browser

# Backward-compat wrapper so `docker-compose` delegates to `docker compose`
RUN printf '#!/bin/sh\nexec docker compose "$@"\n' > /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker-compose

# Startup script: launch rootless dockerd, wait for readiness, then idle
RUN printf '#!/bin/sh\n\
set -eu\n\
dockerd-entrypoint.sh dockerd --iptables=false --ip6tables=false &\n\
until docker version >/dev/null 2>&1; do sleep 0.2; done\n\
echo "Docker is ready"\n\
wait\n' > /home/rootless/boot-docker.sh && chmod +x /home/rootless/boot-docker.sh

ENTRYPOINT ["/sandbox"]
CMD ["/home/rootless/boot-docker.sh"]
