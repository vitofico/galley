# Security Policy

Galley takes its security posture seriously — the threat model, per-surface
defenses, and deployment hardening checklist are documented in
[`docs/security-model.md`](docs/security-model.md), and every release runs the
automated scanning baseline in
[`docs/security-scanning.md`](docs/security-scanning.md) (dependency audit,
secret scan, SAST, image scan, SBOM).

## Supported versions

Galley is pre-1.0. Only the **latest release** (and `main`) receives security
fixes.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

- Preferred: **GitHub private vulnerability reporting** ("Report a security
  vulnerability" under the repository's Security tab).
- Fallback: email the maintainer (address in the git commit history) with
  subject `[SECURITY] Galley: <short summary>`.

Include: affected component (web app / sync relay / proxy / compile service /
web-server / MCP / auth), reproduction steps or PoC, impact assessment, and
the version/commit.

## What to expect

- **Acknowledgement within 72 hours**, an assessment within 7 days.
- Fixes for confirmed High/Critical issues are prioritized over all feature
  work; you'll be credited in the release notes unless you prefer otherwise.
- No bug bounty is offered at this time.

## Scope notes

- Self-host deployments are expected to follow the hardening checklist in
  [`docs/security-model.md`](docs/security-model.md) — e.g. the sync relay and
  model proxy are **not** designed to be exposed unauthenticated to the open
  internet; reports assuming a configuration the docs explicitly call unsafe
  may be triaged as informational.
- The deliberate, documented residual risks (see the "deferred by design"
  section of `security-model.md`) are known; reports that materially change
  their assessed severity are very welcome.
