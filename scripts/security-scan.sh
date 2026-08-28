#!/usr/bin/env bash
# Automated security-scanning baseline (roadmap #22.1) — the single offline/local
# entry point that the CI `security.yml` workflow also calls.
#
#   ./scripts/security-scan.sh                 # run every available scanner
#   ./scripts/security-scan.sh --image NAME    # scan a prebuilt runtime image with trivy
#   ./scripts/security-scan.sh --build-image   # build galley-runtime first, then trivy it
#   ./scripts/security-scan.sh --help
#
# Mirrors the idiom of scripts/validate-k8s.sh + scripts/smoke-selfhost.sh:
#   - `set -euo pipefail`
#   - one PASS/FAIL/SKIP line per scanner in a final summary
#   - exits NON-ZERO on a real failure, 0 otherwise
#   - SKIP-with-message when a tool isn't installed, so it never breaks a
#     contributor's machine. SKIP (tool absent) is DISTINCT from PASS — a scanner
#     that errors or is misconfigured reports FAIL, never a false PASS.
#
# Scanners (each independently skippable):
#   - pnpm audit        dependency advisories vs .security/audit-ignore.json
#   - gitleaks          secret scan of the working tree
#   - semgrep           SAST (registry packs + .security/semgrep-galley.yml)
#   - trivy             runtime-image vulnerability scan (opt-in; needs an image)
#   - syft              CycloneDX SBOM artifact
#
# Fail threshold: a NEW high/critical that is not on the audit ignore-list fails;
# everything else is reported, never silently dropped.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

IGNORE_FILE=".security/audit-ignore.json"
GITLEAKS_CONFIG=".gitleaks.toml"
SEMGREP_LOCAL=".security/semgrep-galley.yml"
RUNTIME_IMAGE="galley-runtime:secscan"
OUT_DIR="${SECURITY_SCAN_OUT:-.security/out}"
SBOM_FILE="$OUT_DIR/sbom.cdx.json"

# --- args --------------------------------------------------------------------
IMAGE=""            # explicit prebuilt image to trivy-scan
BUILD_IMAGE=0       # build galley-runtime before the trivy scan
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --build-image) BUILD_IMAGE=1; shift ;;
    -h|--help)
      sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"

# --- summary plumbing --------------------------------------------------------
declare -a RESULTS=()
fail=0
record() { # record <PASS|FAIL|SKIP> <scanner> <detail...>
  local status="$1" name="$2"; shift 2
  RESULTS+=("$status  $(printf '%-10s' "$name")  $*")
  [[ "$status" == "FAIL" ]] && fail=1
  return 0
}
have() { command -v "$1" >/dev/null 2>&1; }

echo "==> Galley security scan (roadmap #22.1)"
echo "    root: $ROOT"
echo "    ignore-list: $IGNORE_FILE"
echo

# =============================================================================
# 1. Dependency audit — pnpm audit vs the pinned ignore-list
# =============================================================================
echo "--- [1/5] dependency audit (pnpm audit) -------------------------------"
if ! have pnpm; then
  record SKIP "pnpm-audit" "pnpm not installed"
elif ! have node; then
  record SKIP "pnpm-audit" "node not installed (needed to evaluate the policy)"
else
  AUDIT_JSON="$OUT_DIR/pnpm-audit.json"
  # pnpm audit exits NON-ZERO when advisories exist; capture regardless and let
  # node apply the policy. An empty/invalid body (network/registry error) is a
  # FAIL, not a pass — we never report PASS without a parseable audit.
  set +e
  pnpm audit --json >"$AUDIT_JSON" 2>"$OUT_DIR/pnpm-audit.err"
  set -e
  if [[ ! -s "$AUDIT_JSON" ]]; then
    record FAIL "pnpm-audit" "no audit output (registry/offline error — see $OUT_DIR/pnpm-audit.err)"
  else
    # node evaluates: REPORT everything; FAIL only on a NEW high/critical that is
    # not on the ignore-list. Prints a per-advisory table to stdout.
    set +e
    node - "$AUDIT_JSON" "$IGNORE_FILE" <<'NODE'
const fs = require("fs");
const [, , auditPath, ignorePath] = process.argv;

let audit;
try { audit = JSON.parse(fs.readFileSync(auditPath, "utf8")); }
catch (e) { console.error("  ! could not parse pnpm audit JSON:", e.message); process.exit(2); }

let policy = { failOn: ["high", "critical"], ignore: [] };
try {
  const p = JSON.parse(fs.readFileSync(ignorePath, "utf8"));
  if (p.policy && Array.isArray(p.policy.failOn)) policy.failOn = p.policy.failOn;
  if (Array.isArray(p.ignore)) policy.ignore = p.ignore;
} catch (e) {
  console.error("  ! could not read ignore-list (" + ignorePath + "):", e.message);
  console.error("    proceeding with default failOn=high,critical and an EMPTY ignore list.");
}

const failOn = new Set(policy.failOn.map(s => String(s).toLowerCase()));
const ignoredGhsa = new Set(policy.ignore.map(i => i.id).filter(Boolean));
const ignoredNpm = new Set(policy.ignore.map(i => i.npmId).filter(v => v != null).map(String));

const adv = audit.advisories || {};
const ids = Object.keys(adv);
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
let blocking = 0, ignoredCount = 0;

if (ids.length === 0) {
  console.log("    no advisories reported.");
} else {
  console.log("    advisories:");
  for (const id of ids) {
    const a = adv[id];
    const sev = String(a.severity || "unknown").toLowerCase();
    if (sev in counts) counts[sev]++;
    const ghsa = a.github_advisory_id || "";
    const isIgnored = (ghsa && ignoredGhsa.has(ghsa)) || ignoredNpm.has(String(a.id));
    const willFail = failOn.has(sev) && !isIgnored;
    let tag;
    if (isIgnored) { tag = "IGNORED(triaged)"; ignoredCount++; }
    else if (willFail) { tag = "BLOCKING"; blocking++; }
    else { tag = "report"; }
    console.log(
      `      ${tag.padEnd(16)} ${sev.toUpperCase().padEnd(9)} ${ghsa || ("npm#" + a.id)}  ${a.module_name}  (${a.title})`
    );
  }
}

const m = audit.metadata && audit.metadata.vulnerabilities;
if (m) console.log(`    totals: critical=${m.critical} high=${m.high} moderate=${m.moderate} low=${m.low} info=${m.info}`);
console.log(`    ignored(triaged)=${ignoredCount}  blocking(new high/critical)=${blocking}`);

if (blocking > 0) {
  console.error(`  ! ${blocking} new high/critical advisory(ies) not on the ignore-list.`);
  console.error(`    Triage into ${ignorePath} (with rationale) or upgrade the dependency.`);
  process.exit(1);
}
process.exit(0);
NODE
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
      record PASS "pnpm-audit" "no new high/critical beyond the ignore-list"
    elif [[ "$rc" -eq 1 ]]; then
      record FAIL "pnpm-audit" "new high/critical advisory not on the ignore-list"
    else
      record FAIL "pnpm-audit" "audit evaluation error (rc=$rc)"
    fi
  fi
fi
echo

# =============================================================================
# 2. Secret scan — gitleaks over the working tree
# =============================================================================
echo "--- [2/5] secret scan (gitleaks) --------------------------------------"
if ! have gitleaks; then
  record SKIP "gitleaks" "gitleaks not installed (https://github.com/gitleaks/gitleaks)"
else
  # `detect --no-git` scans the working tree (uncommitted state included). For
  # full git-history + pre-commit usage see docs/security-scanning.md. The tuned
  # config allowlists documented test sentinels (real secrets still fail).
  GL_CFG=()
  [[ -f "$GITLEAKS_CONFIG" ]] && GL_CFG=(--config "$GITLEAKS_CONFIG")
  set +e
  gitleaks detect --no-git --redact "${GL_CFG[@]}" --report-format json \
    --report-path "$OUT_DIR/gitleaks.json" --exit-code 1
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    record PASS "gitleaks" "no secrets in the working tree"
  elif [[ "$rc" -eq 1 ]]; then
    record FAIL "gitleaks" "potential secret(s) found — see $OUT_DIR/gitleaks.json"
  else
    record FAIL "gitleaks" "gitleaks error (rc=$rc)"
  fi
fi
echo

# =============================================================================
# 3. SAST — semgrep (registry packs + local ruleset)
# =============================================================================
echo "--- [3/5] SAST (semgrep) ----------------------------------------------"
if ! have semgrep; then
  record SKIP "semgrep" "semgrep not installed (https://semgrep.dev/docs/getting-started/)"
else
  # Registry packs need network; the local ruleset is always offline. Try packs
  # first, fall back to local-only if offline. --error makes findings non-zero.
  CONFIGS=(--config "$SEMGREP_LOCAL")
  if [[ "${SECURITY_SCAN_OFFLINE:-0}" != "1" ]]; then
    CONFIGS+=(--config "p/typescript" --config "p/javascript")
  fi
  set +e
  semgrep scan "${CONFIGS[@]}" \
    --error --metrics off --disable-version-check \
    --json --output "$OUT_DIR/semgrep.json" \
    apps packages scripts
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    record PASS "semgrep" "no findings"
  elif [[ "$rc" -eq 1 ]]; then
    record FAIL "semgrep" "findings reported — see $OUT_DIR/semgrep.json"
  else
    # rc=2 commonly means the registry packs couldn't be fetched (offline).
    if [[ "${SECURITY_SCAN_OFFLINE:-0}" != "1" ]]; then
      echo "    registry packs unavailable (offline?) — retrying with the local ruleset only" >&2
      set +e
      semgrep scan --config "$SEMGREP_LOCAL" --error --metrics off \
        --disable-version-check --json --output "$OUT_DIR/semgrep.json" \
        apps packages scripts
      rc2=$?
      set -e
      if [[ "$rc2" -eq 0 ]]; then
        record PASS "semgrep" "no findings (local ruleset only; registry packs offline)"
      elif [[ "$rc2" -eq 1 ]]; then
        record FAIL "semgrep" "findings (local ruleset) — see $OUT_DIR/semgrep.json"
      else
        record FAIL "semgrep" "semgrep error (rc=$rc2)"
      fi
    else
      record FAIL "semgrep" "semgrep error (rc=$rc)"
    fi
  fi
fi
echo

# =============================================================================
# 4. Runtime-image scan — trivy on galley-runtime
# =============================================================================
echo "--- [4/5] runtime-image scan (trivy) ----------------------------------"
if ! have trivy; then
  record SKIP "trivy" "trivy not installed (https://aquasecurity.github.io/trivy/)"
else
  SCAN_TARGET="$IMAGE"
  if [[ -z "$SCAN_TARGET" && "$BUILD_IMAGE" -eq 1 ]]; then
    if have docker; then
      echo "    building $RUNTIME_IMAGE (--build-image)…"
      if docker build --target runtime -t "$RUNTIME_IMAGE" .; then
        SCAN_TARGET="$RUNTIME_IMAGE"
      else
        record FAIL "trivy" "docker build --target runtime failed"
      fi
    else
      record SKIP "trivy" "--build-image requested but docker is not installed"
    fi
  fi
  if [[ -z "$SCAN_TARGET" ]]; then
    # Default local behaviour: don't build the image (expensive). Only scan if a
    # prebuilt image with the conventional tag already exists.
    if have docker && docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1; then
      SCAN_TARGET="$RUNTIME_IMAGE"
    fi
  fi
  if [[ -z "$SCAN_TARGET" ]]; then
    record SKIP "trivy" "no image to scan (pass --image NAME, or --build-image, or prebuild $RUNTIME_IMAGE)"
  else
    # Fail only on HIGH/CRITICAL with a fix available; report the rest.
    set +e
    trivy image --quiet --scanners vuln \
      --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
      --format json --output "$OUT_DIR/trivy.json" "$SCAN_TARGET"
    rc=$?
    set -e
    # Always emit a human-readable table too (non-failing).
    trivy image --quiet --scanners vuln --severity HIGH,CRITICAL \
      "$SCAN_TARGET" 2>/dev/null || true
    if [[ "$rc" -eq 0 ]]; then
      record PASS "trivy" "no fixable HIGH/CRITICAL in $SCAN_TARGET"
    elif [[ "$rc" -eq 1 ]]; then
      record FAIL "trivy" "fixable HIGH/CRITICAL in $SCAN_TARGET — see $OUT_DIR/trivy.json"
    else
      record FAIL "trivy" "trivy error (rc=$rc)"
    fi
  fi
fi
echo

# =============================================================================
# 5. SBOM — CycloneDX via syft (or trivy as a fallback generator)
# =============================================================================
echo "--- [5/5] SBOM (CycloneDX) --------------------------------------------"
if have syft; then
  set +e
  syft scan "dir:$ROOT" -o "cyclonedx-json=$SBOM_FILE" -q
  rc=$?
  set -e
  if [[ "$rc" -eq 0 && -s "$SBOM_FILE" ]]; then
    record PASS "sbom" "CycloneDX written to $SBOM_FILE (syft)"
  else
    record FAIL "sbom" "syft failed to produce an SBOM (rc=$rc)"
  fi
elif have trivy; then
  # trivy can also emit a CycloneDX SBOM from the filesystem — use it if syft is absent.
  set +e
  trivy fs --quiet --format cyclonedx --output "$SBOM_FILE" "$ROOT"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 && -s "$SBOM_FILE" ]]; then
    record PASS "sbom" "CycloneDX written to $SBOM_FILE (trivy)"
  else
    record FAIL "sbom" "trivy SBOM generation failed (rc=$rc)"
  fi
else
  record SKIP "sbom" "neither syft nor trivy installed (https://github.com/anchore/syft)"
fi
echo

# =============================================================================
# Summary
# =============================================================================
echo "==> security scan summary"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo

if [[ "$fail" -ne 0 ]]; then
  echo "SECURITY SCAN FAILED (one or more scanners reported findings or errored)" >&2
  exit 1
fi
echo "SECURITY SCAN PASSED (SKIPs are tools not installed locally, not failures)"
