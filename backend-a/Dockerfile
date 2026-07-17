# Backend A container image: the OOTB path — the skill is BAKED INTO the
# image (plan §6). Tag pinned to the @cloudflare/sandbox package version.
FROM docker.io/cloudflare/sandbox:0.12.3

# The whole point of backend A: skill delivery via image, no runtime writes.
COPY skills/hoth-trip-planner /workspace/.agents/skills/hoth-trip-planner
