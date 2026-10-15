# Dedicated sandbox image for Agent-Transformer's run_command.
#
# UNTESTED in this verification pass: the machine used had no Docker/Podman, so this
# was not built or run. Build and exercise it on a machine with a runtime:
#
#   # 1. pin the base by digest (do this on the target, do not trust a copied digest):
#   docker pull node:24-bookworm-slim
#   docker inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim
#   #   -> node:24-bookworm-slim@sha256:<digest>   (paste into the FROM line below)
#
#   # 2. build and run the real-container test against it:
#   docker build -t agent-sandbox:local sandbox
#   AGENT_SANDBOX_TEST_IMAGE=agent-sandbox:local npx tsx --test src/tools/sandbox.test.ts
#
# What it provides for coding tasks: Node 24 (from the base), git, curl, python3, a C
# toolchain (build-essential) and util-linux for `setsid -w` (so stopping a command
# kills its whole process group inside the container instead of restarting it).
#
# The base is the official Node 24 image on Debian bookworm-slim. Pin it by digest for
# reproducibility — replace the tag below with node:24-bookworm-slim@sha256:<digest>
# obtained by step 1 above. The tag form is left active so the file builds out of the
# box; a release build should use the digest.
FROM node:24-bookworm-slim
# For a pinned build, comment the line above and use, e.g.:
# FROM node:24-bookworm-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000

# Packages only; no secrets, no tokens, no credentials are baked in.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        git \
        curl \
        python3 \
        build-essential \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

# The runner mounts the host workspace here and sets --workdir; create it so the image
# also works standalone.
WORKDIR /workspace

# Run as a non-root user by default. The base image ships an unprivileged `node` user
# (uid 1000). On Linux the runner overrides this with the host uid (--user / --userns
# keep-id) so written files stay host-owned; on Docker Desktop the image user is used.
USER node

# The runner replaces this with its own keep-alive command; a harmless default for
# standalone use.
CMD ["node", "--version"]
