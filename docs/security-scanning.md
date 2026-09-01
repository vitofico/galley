# Security scanning

Galley runs a **recurring automated security-scanning baseline** so regressions are
caught continuously, not in a one-off audit. The same scanners run locally and in CI
from one source of truth: [`scripts/security-scan.sh`](../scripts/security-scan.sh).

- **CI:** [`.github/workflows/security.yml`](../.github/workflows/security.yml) — on every
  **pull request**, a **weekly schedule** (Mondays 07:17 UTC), and **manual dispatch**. It is
  isolated from `ci.yml`: each scanner is its own job, and a security failure never blocks the
  app green-gate.
- **Local:** `bash scripts/security-scan.sh` — runs every scanner that is installed and **SKIPs**
  (with a message) the ones that aren't, so it never breaks a contributor's machine.

## Scanners and fail thresholds

| Scanner | What it checks | Fails the gate when… | Local-only behaviour |
| --- | --- | --- | --- |
| **pnpm audit** | dependency advisories | a **new HIGH/CRITICAL** advisory not on the ignore-list | always runs (pnpm + node present) |
| **gitleaks** | secrets in the tree/history | any non-allowlisted secret match | SKIP if `gitleaks` absent |
| **semgrep** | SAST (TS/JS) | a ruleset finding (`--error`) | SKIP if `semgrep` absent; local ruleset works offline |
| **trivy** | runtime-image CVEs | a **fixable HIGH/CRITICAL** in `galley-runtime` | SKIP unless an image is built/passed |
| **syft** | CycloneDX SBOM | (never fails — artifact only) | SKIP if `syft`/`trivy` absent |

`SKIP` (tool not installed) is **distinct from `PASS`**. A scanner that errors or is misconfigured
reports `FAIL`, never a false `PASS`.

### Local options

```bash
bash scripts/security-scan.sh                 # every available scanner
bash scripts/security-scan.sh --image NAME    # trivy-scan a prebuilt image
bash scripts/security-scan.sh --build-image   # build galley-runtime, then trivy it
SECURITY_SCAN_OFFLINE=1 bash scripts/security-scan.sh   # semgrep: local ruleset only (no registry)
```

Reports and the SBOM are written to `.security/out/` (gitignored). Install the optional scanners
to exercise their lanes locally:

```bash
brew install gitleaks trivy syft        # macOS
pipx install semgrep                     # or: pip install semgrep
```

## Dependency-audit ignore-list policy

The ignore-list lives at [`.security/audit-ignore.json`](../.security/audit-ignore.json). It is a
**triage record, not a silencer**: an advisory listed there is reported as `IGNORED(triaged)` so it
never disappears, and the scan still **fails on any new HIGH/CRITICAL that is not listed**.

To add a triaged advisory, append an object with **all** of these fields:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",   // GHSA id (preferred match key)
  "npmId": 1234567,               // numeric pnpm/npm advisory id (fallback match)
  "module": "package-name",
  "severity": "critical",
  "reason": "Why this is not exploitable in Galley / why it can't be fixed yet.",
  "addedDate": "YYYY-MM-DD",
  "reviewBy": "YYYY-MM-DD"        // force a re-look; don't let it rot
}
```

**Rules:** the ignore-list is for advisory IDs only — **never secrets**. Every entry needs a written
rationale. Prefer upgrading the dependency over ignoring it; ignore only when the advisory is
genuinely not applicable or has no available fix. Re-review on the `reviewBy` date (the weekly run
re-surfaces everything that is still outstanding).

## Currently triaged advisories

The triaged dependency advisories are all in the **dev toolchain** (vite / vitest /
esbuild), none of which ship in the `galley-runtime` production image (it serves prebuilt
`dist` via `tsx`, not vite/vitest):

| Advisory | Module | Severity | Why triaged (not a runtime risk) |
| --- | --- | --- | --- |
| `GHSA-5xrq-8626-4rwp` (npm#1120126) | vitest | CRITICAL | Arbitrary file read **via the Vitest UI server**, and only when that UI/Browser-mode server is started **and** exposed (`--api.host`) or run on Windows. Galley runs Vitest headless in Docker (`pnpm test` = `vitest run`); the UI is never started, and the runtime image ships no vitest. Clears on the vitest 2→3 major bump. |
| `GHSA-gv7w-rqvm-qjhr` | esbuild | HIGH | Unverified-integrity binary fetch in esbuild's **Deno** module-install path (RCE only if a Deno consumer points `NPM_CONFIG_REGISTRY` at a malicious registry). Galley consumes esbuild only transitively via vite/vitest under Node + pnpm with a locked registry; it never uses the Deno loader, and the runtime image ships prebuilt `dist` (no esbuild). Clears when vite/vitest pull a fixed esbuild. |
| `GHSA-fx2h-pf6j-xcff` (npm#1120789) | vite | HIGH | `server.fs.deny` bypass via **Windows** alternate path forms against a running vite **dev** server. vite is dev/build-only here (vitest + plugin-react); the runtime image never runs vite, and Galley dev + CI run on Linux/macOS. No 5.4.x backport exists (fix first lands in vite 6.4.3), so a real fix needs a vite 5→7 major bump for a non-applicable advisory. Clears when vitest/plugin-react pull a fixed vite. |
| `GHSA-67mh-4wv8-2f99` (npm#1102341) | esbuild | moderate | Dev-server CORS leak; reachable only via vite's **dev** server, which CI/production never run. Moderate ⇒ non-failing anyway. Clears at esbuild ≥ 0.25.0. |
| `GHSA-4w7w-66w2-5vf9` (npm#1116229) | vite | moderate | Path traversal in vite's optimized-deps `.map` handling — only against a running vite **dev** server. Clears at vite ≥ 6.4.2. |

**Secret scan:** a handful of fake `ghp_…` constants in `*.test.ts` / `*.spec.ts` files (e.g.
`ghp_TOPSECRET1234567890`, `ghp_LIVEPROBE_SENTINEL_NEVER_ON_WIRE_0001`) are deliberate **dummy
sentinels that test token-redaction logic** — never real, never on the wire. They are allowlisted
in [`.gitleaks.toml`](../.gitleaks.toml) by exact value, so real secrets in application/config
code still fail. The pairing/control-crypto tests (ADR-0026) add three more exact-value entries:
`Y29udHJvbC1yZXNwb25zZS1rZXktMzItYnl0ZXNfXw` — the fake bootstrap `responseKey` in
`pairing-bootstrap.test.ts`, a base64url constant that literally decodes to
`control-response-key-32-bytes__` — plus `attacker-mapkey-0123456789abcdef` and
`attacker-key-0123456789abcdef00`, the deliberately hostile map keys in the claim-spoofing
tests (`control-responder-mount-pairing.test.ts`, `control-mailbox.test.ts`).

## Secret scanning: full history + pre-commit

`scripts/security-scan.sh` scans the **working tree** (`gitleaks detect --no-git`). Two complements:

- **Full git history** (recommended periodically; the scheduled CI job checks out full depth):

  ```bash
  gitleaks detect --config .gitleaks.toml --redact   # scans all commits
  ```

- **Pre-commit hook** — stop a secret before it's ever committed. Add to
  [`.pre-commit-config.yaml`](../.pre-commit-config.yaml):

  ```yaml
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.21.2
    hooks:
      - id: gitleaks
  ```

  then `pre-commit install`. The hook honours `.gitleaks.toml`, so the same allowlist applies.

## How the local ruleset relates to ast-grep

The repo already runs an **ast-grep** structural-hygiene set (`rules/` + `sgconfig.yml`: no-eval,
no-`Function`, no-debugger, no-console, no-`ts-ignore`). The semgrep config under
[`.security/semgrep-galley.yml`](../.security/semgrep-galley.yml) **complements** it — it targets
security smells the hygiene set does not (shell-interpolated `exec`, `dangerouslySetInnerHTML`,
request-derived filesystem paths) — plus the broad `p/typescript` + `p/javascript` registry packs in
CI. It does not duplicate the ast-grep rules.
