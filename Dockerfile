FROM alpine/git:2.49.1 AS agentteams-source
ARG AGENTTEAMS_COMMIT=223ddc2b8073e4c8b93bcbb15e1d717f196c04d9
RUN git clone https://github.com/agentscope-ai/AgentTeams.git /src/AgentTeams \
    && git -C /src/AgentTeams checkout "${AGENTTEAMS_COMMIT}"

FROM node:22.19.0-bookworm-slim AS node-runtime

FROM python:3.12.11-slim-bookworm
COPY --from=node-runtime /usr/local/ /usr/local/
ARG TARGETARCH
ARG DSH_VERSION=0.1.1-rc.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" \
    && ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && curl -fsSL "https://dl.min.io/client/mc/release/linux-${ARCH}/mc" -o /usr/local/bin/mc \
    && chmod 0755 /usr/local/bin/mc

WORKDIR /opt/agentteams-dsh-runtime
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY LICENSE README.md THIRD_PARTY_NOTICES.md ./
COPY bin ./bin
COPY acp ./acp
COPY profiles ./profiles
COPY src ./src
RUN pip install --no-cache-dir deepagents==0.7.6 deepagents-acp==0.0.8 langchain-deepseek==1.1.0
COPY --from=agentteams-source /src/AgentTeams/plugins/teamharness/mcp /opt/agentteams/teamharness/mcp
COPY --from=agentteams-source /src/AgentTeams/LICENSE /opt/agentteams/LICENSE

RUN mkdir -p /workspace/shared /var/lib/agentteams-dsh-manager
WORKDIR /workspace
ENV AGENTTEAMS_WORKSPACE_DIR=/workspace \
    AGENTTEAMS_SHARED_DIR=/workspace/shared \
    AGENTTEAMS_TEAMHARNESS_SERVER=/opt/agentteams/teamharness/mcp/server.py \
    AGENTTEAMS_PYTHON_BIN=python3 \
    JUCHANG_DSH_BIN=/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
    JUCHANG_MANAGER_STATE_DIR=/var/lib/agentteams-dsh-manager
ENTRYPOINT ["node", "/opt/agentteams-dsh-runtime/bin/bootstrap.mjs"]
