# @galley/shared

Cross-package types and contracts. **Types, pure constants, and small pure helpers
only** — no I/O, no framework imports, no runtime dependencies. If a definition needs
a dependency, it does not belong here.

## Modules

| File | Contract |
| --- | --- |
| `diagnostics.ts` | `Diagnostic`, `SourceSpan` — normalized compiler feedback |
| `compile.ts` | `CheckResult`, `RenderResult`, `ExportResult` — the three compile outputs |
| `edits.ts` | `EditBlock`, `ApplyResult`, `EditFailure` — search/replace editing |
| `document.ts` | `DocumentSnapshot`, `Revision`, `ContentHash` — identity & conflict detection |
| `provider.ts` | `ProviderConfig`, `ProviderCapabilities` — BYO-model config + probing |
| `proxy.ts` | `UpstreamConfig`, `GALLEY_UPSTREAM_HEADER` — the model-proxy upstream contract |
| `agent-events.ts` | `AgentEvent` — the streamed agent progress events |
| `author.ts` | `Author` — collaborator identity for cross-peer attribution |
| `persistence.ts` | `Authorizer`, `Project`, `ProjectRole`, `ProjectPatch` — project store + authorization seams |
| `auth.ts` | `OidcProviderConfig`, `IdTokenClaims`, `SessionStore` — OIDC auth + session contracts |
| `capability-rooms.ts` | `CapabilityRoomRecord`, `CapabilityRoomStore` — Agent Access capability-room contracts |

These types are the seams between packages. Changing one is an API change —
update the relevant doc in [`docs/`](../../docs) alongside it.
