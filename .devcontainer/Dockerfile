FROM mcr.microsoft.com/devcontainers/base:ubuntu24.04

ARG BUN_VERSION=1.3.6

USER vscode

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

COPY --chmod=0755 entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
