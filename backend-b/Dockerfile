# Backend B container image: SKILL-FREE by hard requirement (plan §6) — only
# the Cloudflare sandbox base (which bundles node). /workspace/.agents/skills
# is empty at boot; if any skill file were baked in, B would be discovering a
# baked copy instead of testing dynamic injection (verified by the §13
# clean-base test).
FROM docker.io/cloudflare/sandbox:0.12.3
