# ADR-0022 — Licensing: AGPL-3.0-only + CLA + trademark policy

- **Status:** Accepted (2026-06-11)
- **Decider:** the operator (roadmap #21.3 explicitly reserves this decision for
  a human; made 2026-06-11 in conversation, applied the same day)
- **Context:** roadmap #21 ("go-public"), slice 21.3

## Context

Galley will eventually go public as an **open-core** project behind a **paid
hosted offering** (the Overleaf model). Until 2026-06-11 the repo was
Apache-2.0, which lets anyone — including a well-resourced competitor — run a
modified Galley as a paid service without sharing their changes or crediting
the project. The license had to be settled **before** going public and before
any outside contribution lands (relicensing afterwards needs every
contributor's consent).

The operator's stated goal: *prevent competitors from exploiting the software
without anything coming back*. Three honest observations shaped the choice:

1. **No OSI license forces public credit.** Both Apache and AGPL only require
   preserving notices in source; a competitor may rebrand. "Mention" is a
   **trademark** concern, not a copyright-license one.
2. **AGPL's network copyleft is the strongest OSI-approved deterrent**: anyone
   offering a *modified* Galley as a network service must publish their
   modifications under AGPL — which removes a proprietary competitor's edge
   (the MongoDB/Grafana/Overleaf-CE precedent).
3. Outright prohibition of competing managed services would require a
   source-available license (BUSL-1.1, Elastic 2.0) at the cost of not being
   open source. Rejected for now; can be revisited only while the operator
   remains sole copyright holder.

## Decision

1. **License: `AGPL-3.0-only`** for the whole repository (apps *and*
   `packages/*`). One license keeps the story simple; the sole copyright
   holder can always carve out a permissive per-package exception later if
   library adoption ever warrants it (the reverse — tightening — would not be
   possible after outside contributions). "-only" (not "-or-later") so a future
   FSF license revision cannot be applied without an explicit operator
   decision.
2. **CLA, not DCO** (`/CLA.md`, v1.0): contributors grant a relicensing/
   dual-licensing right. This is what keeps the proprietary hosted offering
   legally composable with outside contributions (Overleaf does the same).
   Enforcement: a statement in the first PR; a CLA-bot when the repo goes
   public.
3. **Trademark policy** (`/TRADEMARKS.md`): forks are welcome but must rename;
   no hosted service under the "Galley" name without permission. The brand —
   not the license — is what guarantees attribution-in-practice. Registration
   in key markets remains a future operator action (21.2/21.3 rider).
4. **Open-core seam:** hosted-only concerns (billing, quotas, tenant admin,
   SSO beyond OIDC, ops dashboards) live in a **separate private repo**
   composing against the public seams (`ProjectStore` / `Authorizer` / the
   compile service). They are never added to this repo. (Restates the
   roadmap-#21.3(b) policy as a standing rule.)
5. **No per-file license headers** for now. AGPL "how to apply" *recommends*
   headers but they are not a condition; `LICENSE` + `NOTICE` + the root
   `package.json` SPDX field govern. Revisit at 21.2 (repo hygiene) if desired.

## Consequences

- The dual-licensing right depends on the operator owning all copyright:
  **no outside contribution may merge without CLA agreement** — this is now a
  hard invariant (CONTRIBUTING documents it).
- Typst (Apache-2.0) remains compatible: Apache-2.0 code can be incorporated
  into an AGPL-3.0 work (one-way compatibility). Typst's NOTICE obligations
  are unchanged (see `/NOTICE`).
- Self-hosters are unaffected; only those **modifying and serving** Galley to
  others over a network acquire the source-publication duty.
- Relicensing was clean at decision time: single author (verified via
  `git shortlog -sne`, 2026-06-11), no outside contributors, repo still
  private.
- Files changed at adoption: `LICENSE` (canonical AGPL-3.0 text), `NOTICE`,
  root `package.json` (`license: "AGPL-3.0-only"`), `CLA.md` (new),
  `TRADEMARKS.md` (new), `CONTRIBUTING.md`, `README.md`,
  `docs/vision.md#licensing--branding`, roadmap #21.3.
