# Backend A container image: the OOTB path — the skill is BAKED INTO the
# image (plan §6). Tag pinned to the @cloudflare/sandbox package version.
#
# Build context is the REPO ROOT (wrangler.jsonc sets image_build_context "..")
# so this Dockerfile can COPY the shared semantius CLI from linux-x64/. Every
# COPY source below is therefore relative to the repo root, NOT to backend-a/.
#
# --platform=linux/amd64 is REQUIRED: semantius is an x86-64 binary and
# Cloudflare Containers only run linux/amd64. Without this, a build on an arm64
# host (e.g. Windows arm64) would default to an arm64 image and the x64 binary
# would fail with "exec format error". Pinning it makes the build host-agnostic.
FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.12.3

# semantius platform CLI: a prebuilt linux-x64 binary installed onto PATH as
# `semantius` so the agent can call it straight from bash inside the sandbox
# (/usr/local/bin is on PATH). chmod because a COPY from a Windows/Git checkout
# may not carry the execute bit.
COPY linux-x64/semantius-linux-x64 /usr/local/bin/semantius
RUN chmod 0755 /usr/local/bin/semantius

# yq (mikefarah/yq): jq is already in the Ubuntu base image, yq is not. Install
# the pinned static linux/amd64 binary onto PATH so the agent can process YAML
# from bash just like jq. Pinned for reproducibility — bump YQ_VERSION to update.
ARG YQ_VERSION=v4.44.3
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
      -o /usr/local/bin/yq \
 && chmod 0755 /usr/local/bin/yq

# semantius runtime config. SEMANTIUS_API_KEY here is a PLACEHOLDER (sentinel),
# NOT the real key: the container never holds the real secret. The Worker's
# catch-all egress handler swaps this value — wherever it appears in an outbound
# request header — for the real key. Safe to bake in. Keep this value in sync
# with SEMANTIUS_KEY_SENTINEL in core/src/config.js.
ENV SEMANTIUS_API_KEY=__sak__ \
    SEMANTIUS_ORG=tests

# Trust the Cloudflare Containers egress-interception CA so semantius's HTTPS
# calls to <org>.semantius.ai succeed when interceptHttps is on. The sandbox
# runtime provisions the real cert at this exact path; semantius (a Bun binary)
# trusts it additively via NODE_EXTRA_CA_CERTS (verified: the binary reads this
# env). Not pre-created here — the runtime owns the file, and an empty stub could
# shadow the real cert. In plain (non-intercepted) runs the file is simply
# absent and semantius falls back to the system CA store.
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt

# The whole point of backend A: skill delivery via image, no runtime writes.
# COPY of a directory copies its CONTENTS, so every skills/<skill>/ subfolder of
# the fixed hoth-trip-planner agent lands as /workspace/.agents/skills/<skill>.
COPY agents/hoth-trip-planner/skills /workspace/.agents/skills
