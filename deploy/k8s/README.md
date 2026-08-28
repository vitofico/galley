# Galley on Kubernetes (roadmap #5, ADR-0017)

Self-host manifests for the three core services, managed with **Kustomize**.
**Security-Analyst (GPT) reviewed** — the defaults are deliberately conservative:
only the static **web** SPA is publicly exposed; **proxy** and **sync** are
ClusterIP-only with a default-deny NetworkPolicy, because they have **no
authentication yet** (roadmap #4). The web app is standalone (in-browser compile +
local CRDT), so web-only is a complete Galley.

## Layout

```
deploy/k8s/
  kustomization.yaml        # default convenience wrapper → base
  base/                     # the conservative default set + opt-in raw manifests
    00-namespace.yaml … 40-sync.yaml   (in `resources`)
    90-expose-proxy-sync.opt-in.yaml   (NOT in resources — explicit opt-in)
    kustomization.yaml      # pins the image (images:) ONCE
  components/               # reusable kustomize Components (compose into overlays)
    compile/                # sandbox-only server compile (+ compile.yaml)
    compile-registry/       # compile WITH Universe packages (egress policy + integrity ConfigMap)
    auth/                   # OIDC login + closed sync rooms (PVCs + example Secret)
  overlays/                 # applyable feature combinations
    compile/  compile-registry/  auth/  auth-compile/  auth-compile-registry/
```

The base **is** the default deployment. Overlays add features by composing
components — they compose cleanly (`auth` patches web/sync; `compile*` adds the
compile pod + a web env), which is why `auth-compile` / `auth-compile-registry`
exist as ready-made combinations.

## Prerequisites

- Build + push the runtime image (the Dockerfile `runtime` target):
  ```bash
  docker build --target runtime -t <registry>/galley-runtime:<tag> .
  docker push <registry>/galley-runtime:<tag>
  ```
  Then pin it **once** (instead of editing every Deployment) in
  `base/kustomization.yaml`, or via:
  ```bash
  cd deploy/k8s/base
  kustomize edit set image galley-runtime=<registry>/galley-runtime:<tag>
  ```
  **Pin an immutable tag or digest** (`…@sha256:…`) in production — `:latest` +
  `imagePullPolicy: IfNotPresent` is a stale-image footgun (pods may keep running
  an old cached image).
- An ingress controller (manifests assume `ingress-nginx`) + cert-manager (or
  remove the TLS/annotations). Update `galley.example.com` to your host.

## Apply (default: web + proxy + sync, only web exposed)

```bash
kubectl apply -k deploy/k8s
```

That renders + applies the base as ONE unit. `proxy` and `sync` are reachable
only inside the namespace; the browser talks to them by **opting in** via query
params/settings to a URL you expose — which you should only do behind auth.

Preview what any target renders without applying:

```bash
kubectl kustomize deploy/k8s                          # or: kustomize build …
```

## Overlays (opt-in features)

| Overlay | Adds | Apply |
| --- | --- | --- |
| `overlays/compile` | server-side compile, **sandbox-only** (packages fail closed, worker isolation — the default, set explicitly) | `kubectl apply -k deploy/k8s/overlays/compile` |
| `overlays/compile-registry` | compile **+ Universe packages** (egress policy + integrity ConfigMap; isolation set to `inline`) | `kubectl apply -k deploy/k8s/overlays/compile-registry` |
| `overlays/auth` | OIDC login + closed sync rooms (shared session PVC + example Secret) | `kubectl apply -k deploy/k8s/overlays/auth` |
| `overlays/auth-compile` | both of the above (sandbox compile) | `kubectl apply -k deploy/k8s/overlays/auth-compile` |
| `overlays/auth-compile-registry` | auth + compile with Universe packages | `kubectl apply -k deploy/k8s/overlays/auth-compile-registry` |

Each overlay header lists its prerequisites; the highlights:

### `+compile` — server-side compile (ADR-0015)

The compile Service is **ClusterIP-only by design**. The browser's Server/Auto
compile toggle fetches `GALLEY_COMPILE_URL` *from the user's browser*, so it must
be an **external, browser-reachable URL** — NOT the internal
`galley-compile.galley.svc` DNS name (unreachable from a browser; it would
silently fail). Expose compile through your ingress (e.g.
`https://galley.example.com/compile`) and set that URL in `components/compile`.
Empty = OFF (the served app never advertises a compile server — never a dead
server). Sandbox-only: packages fail closed; each compile runs in a terminable
worker_thread (`GALLEY_COMPILE_ISOLATION=worker` — the default since 2026-07, set
explicitly in `compile.yaml` so the manifest is self-describing); the pod gets no
egress beyond DNS.

### `+compile-registry` — Universe packages (ADR-0016)

Enables registry resolution. Two honest constraints, handled in the overlay:

- **Isolation is set to `inline`.** The compile server **throws at startup** if
  `GALLEY_COMPILE_ISOLATION` resolves to `worker` (the default since 2026-07,
  including when the var is unset) and `REGISTRY_BASE_URL` is set (the per-request
  worker_thread has no package resolver). So this overlay sets
  `GALLEY_COMPILE_ISOLATION=inline` **explicitly** (never relying on the default)
  and leans on the **container resource limits + a kubelet `podPidsLimit`** for
  runaway protection. You cannot have terminable isolation *and* Universe packages
  today — use the sandbox-only `compile` overlay (or an internal mirror) if you
  need isolation.
- **The integrity ConfigMap ships with PLACEHOLDER hashes** — every package fails
  closed until you replace it. Generate a real, reviewed manifest with
  `pnpm --filter @galley/compile build:manifest` (see
  `docs/server-side-compile.md`) and regenerate
  `components/compile-registry/integrity-configmap.example.yaml` from it. The file
  format is `{ "@ns/name:version": { sha256, size } }`, mounted at
  `REGISTRY_INTEGRITY_FILE`.
- **Registry egress is allowed but NOT host-scoped.** A vanilla NetworkPolicy
  can't match a hostname, so `allow-compile-egress-registry` opens compile → any
  host on 443. **Tighten it**: pin the registry/mirror CIDR in `ipBlock`, use a
  CNI FQDN policy (Cilium `toFQDNs`, Calico domain sets), or front the registry
  with an egress proxy/host-firewall allowlist. See the policy's header.

### `+auth` — OIDC login + closed rooms (14-E)

Replaces the old comment-uncommenting dance with kustomize patches that inject the
OIDC env onto **both** web and sync, mount a **shared RWX session PVC** into both
(a web-minted session must validate in the sync pod), add a projects PVC for sync
membership, and reference a `galley-oidc` Secret. `GALLEY_SESSION_DIR` MUST match
between web and sync; both processes **fail closed at startup** if their shared
dirs are missing — the security posture is identical to the previous commented
blocks. Since #1 slice 2 the sync relay ALSO **requires
`GALLEY_SYNC_ALLOWED_ORIGINS`** under `GALLEY_SYNC_AUTH=required` (set it to your
exact public origin, e.g. `https://galley.example.com`) and refuses to start
without it — add the env to the sync patch alongside `GALLEY_SYNC_AUTH`. The
**web** pod additionally needs `GALLEY_DATA_DIR` (the same shared volume sync
mounts) so its capability-room registration routes (Share / Agent Access) can
write the registry the relay reads. Before applying: replace the **EXAMPLE** `galley-oidc` Secret with real
values created out-of-band (never commit real secrets — see
`components/auth/oidc-secret.example.yaml`), set `GALLEY_PUBLIC_BASE_URL` to your
external origin, and set an **RWX-capable** `storageClassName` on the PVCs
(`components/auth/pvcs.yaml`; default block storage usually does NOT support RWX —
though on a **single-node** cluster a hostpath provisioner such as microk8s's
`microk8s-hostpath` binds RWX just fine).

Two deployment gotchas worth knowing:

- **The web pod dials the IdP.** OIDC issuer discovery happens at web-server
  startup (fail-closed) and the token exchange on every login — under the base's
  default-deny egress both would hang. The component ships
  `allow-web-egress-https` (`components/auth/networkpolicy.yaml`) for exactly
  this; tighten it to your IdP's CIDR if you can.
- **IdP behind the same NAT?** If the IdP hostname resolves to your own public
  IP (self-hosted IdP on the same network), pods need working **hairpin NAT** —
  or a split-horizon CoreDNS rewrite to the ingress controller's internal IP.
  The symptom is the same crashloop connect-timeout as a missing egress rule.

## Validate (offline)

```bash
./scripts/validate-k8s.sh
```

Renders the base + every overlay and schema-validates the output with **no cluster
connection** — `kubeconform` if installed (schema-aware, preferred), else
`kubectl apply --dry-run=client`. Exits non-zero on any failure with a per-target
PASS/FAIL summary; skips gracefully if neither tool is present. This runs in CI
(`.github/workflows/ci.yml`, job `k8s-manifests`) so the manifests can't silently
rot. (Note: the `kubectl --dry-run=client` fallback is lenient on some schema
errors that `kubeconform` catches — CI uses `kubeconform`.)

## Hardening baked in

- **PodSecurity `restricted`** namespace; every pod is `runAsNonRoot` (uid 1000),
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true` (+ a small
  `emptyDir` `/tmp` with `TMPDIR`/`HOME`/`XDG_CACHE_HOME` for tsx/esbuild),
  `seccompProfile: RuntimeDefault`, all capabilities dropped,
  `automountServiceAccountToken: false`, and resource requests/limits.
- **Default-deny NetworkPolicy** (ingress + egress); only DNS egress + ingress-
  controller→web are allowed. Overlays add the minimum extra egress they need.
- **sync**: `replicas: 1` + `strategy: Recreate` — rooms are in-memory and must not
  be split across pods; do not add an HPA until a shared backend exists.

## ⚠️ Exposing proxy / sync (opt-in, needs auth)

`base/90-expose-proxy-sync.opt-in.yaml` adds their Ingress + the NetworkPolicy
allow-rules. It is **not** in any kustomization (apply it explicitly with
`kubectl apply -f base/90-expose-proxy-sync.opt-in.yaml`). **Do not apply it
without an external auth layer** (oauth2-proxy / mTLS / source-IP allowlist): an
open proxy lets anyone spend your model key, and an open sync relay lets anyone
read/tamper any room. Even with the `+auth` overlay (which closes the rooms via
OIDC), front these hosts with your own auth/allowlist — they have no
authentication of their own yet (roadmap #4).

### A pragmatic proxy-exposure pattern (capability path)

The SPA's proxy transport needs a **browser-reachable** proxy URL (never the
ClusterIP DNS name). For a personal/self-host deploy without a forward-auth
stack, an **unguessable path prefix** on the existing web host works as a
capability URL — the same model Galley uses for sync room ids:

1. Route `/<random-token>` (e.g. `/llm-$(openssl rand -hex 12)`) on your web
   host to the proxy Service, with a strip-prefix rule (ingress-nginx:
   `rewrite-target`; Traefik: a `stripPrefix` Middleware).
2. Add a NetworkPolicy allowing your ingress controller → proxy :8787 (the
   base deliberately ships none).
3. Keep `ALLOWED_ORIGINS` pinned to your web origin, and put the full URL
   (`https://<host>/llm-…`) in Settings → AI → Proxy URL.

Caveats: the token sits in your manifests (treat the repo accordingly; rotate
by changing the prefix) — and prefer a path over a secret **subdomain**, whose
name would leak via Certificate-Transparency logs.

## Compile sandboxing

The compile overlays ship tight CPU/mem/ephemeral limits (a synchronous WASM
compile can't be preempted by a JS timeout — the container limits are the
isolation, ADR-0015 §4). Also set a kubelet `podPidsLimit` on its nodes. If you
enable Universe fetch (`compile-registry`), restrict egress to the registry host
as described above, and remember it is mutually exclusive with worker isolation.
