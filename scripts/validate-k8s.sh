#!/usr/bin/env bash
# Offline validation of the Kubernetes deployment set (roadmap #5 slice 6).
#
# Renders the kustomize base + EVERY overlay and schema-validates the output
# WITHOUT a cluster, so the manifests can't silently rot as features grow.
#
#   ./scripts/validate-k8s.sh
#
# Tooling (all OFFLINE — no API server contact):
#   - Renderer:  `kustomize` if present, else `kubectl kustomize`.
#   - Validator: `kubeconform` if present (schema-aware, fully offline), else
#                `kubectl apply --dry-run=client` (client-side; needs no cluster).
# If neither a renderer nor a validator is available, the script SKIPS with a
# clear message and exits 0 (so environments without the tools don't break) — but
# if a validator IS present and validation fails, it exits NON-ZERO.
set -euo pipefail

cd "$(dirname "$0")/.."

K8S_DIR="deploy/k8s"

# Every applyable kustomization target (base + overlays). The bare $K8S_DIR is
# the default convenience wrapper; the rest are opt-in overlays.
TARGETS=(
  "$K8S_DIR"
  "$K8S_DIR/base"
  "$K8S_DIR/overlays/compile"
  "$K8S_DIR/overlays/compile-registry"
  "$K8S_DIR/overlays/auth"
  "$K8S_DIR/overlays/auth-compile"
  "$K8S_DIR/overlays/auth-compile-registry"
)

# --- pick a renderer ---------------------------------------------------------
RENDER=()
if command -v kustomize >/dev/null 2>&1; then
  RENDER=(kustomize build)
elif command -v kubectl >/dev/null 2>&1; then
  RENDER=(kubectl kustomize)
else
  echo "SKIP: neither 'kustomize' nor 'kubectl' is installed; cannot render manifests." >&2
  echo "      Install one to validate (e.g. https://kubectl.docs.kubernetes.io/installation/kustomize/)." >&2
  exit 0
fi

# --- pick a validator --------------------------------------------------------
# kubeconform is preferred (schema-aware, fully offline, no kube-context needed).
VALIDATOR=""
if command -v kubeconform >/dev/null 2>&1; then
  VALIDATOR="kubeconform"
elif command -v kubectl >/dev/null 2>&1; then
  VALIDATOR="kubectl"
else
  echo "SKIP: no validator ('kubeconform' or 'kubectl') installed; cannot validate." >&2
  echo "      Install kubeconform (a single static binary) for offline schema checks." >&2
  exit 0
fi

echo "==> renderer:  ${RENDER[*]}"
echo "==> validator: $VALIDATOR"
echo

# Validate one already-rendered manifest stream (stdin) for a target.
validate_stream() {
  local name="$1"
  if [[ "$VALIDATOR" == "kubeconform" ]]; then
    # -strict: reject unknown fields; -summary keeps output terse. Skip the
    # CRD-less custom kinds we don't ship (none today, but future-proof).
    kubeconform -strict -summary -ignore-missing-schemas
  else
    # Client-side dry-run validates structure/required fields with NO API server.
    kubectl apply --dry-run=client -f - >/dev/null
  fi
}

fail=0
declare -a RESULTS=()
for t in "${TARGETS[@]}"; do
  if [[ ! -f "$t/kustomization.yaml" ]]; then
    RESULTS+=("FAIL  $t  (no kustomization.yaml)")
    fail=1
    continue
  fi

  # Render first; a render error is itself a failure.
  if ! rendered="$("${RENDER[@]}" "$t" 2>/tmp/validate-k8s.render.err)"; then
    RESULTS+=("FAIL  $t  (render error)")
    sed 's/^/        /' /tmp/validate-k8s.render.err >&2
    fail=1
    continue
  fi

  if printf '%s\n' "$rendered" | validate_stream "$t" 2>/tmp/validate-k8s.val.err; then
    RESULTS+=("PASS  $t")
  else
    RESULTS+=("FAIL  $t  (validation error)")
    sed 's/^/        /' /tmp/validate-k8s.val.err >&2
    fail=1
  fi
done

echo "==> k8s manifest validation summary"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo

rm -f /tmp/validate-k8s.render.err /tmp/validate-k8s.val.err
if [[ "$fail" -ne 0 ]]; then
  echo "K8S VALIDATION FAILED" >&2
  exit 1
fi
echo "K8S VALIDATION PASSED (${#TARGETS[@]} targets)"
