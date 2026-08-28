# Connect GitHub (v0) — paste-a-PAT + manual snapshot push

A one-way bridge from a Galley project to a GitHub repository. You paste a
personal access token in **Settings → Connect GitHub**, pick (or create) a
repository, and the project's **Git panel** gains a **Push snapshot to GitHub**
button. Each push replaces the branch contents with the project's current
files. Nothing is ever fetched back: the CRDT remains the single source of
truth, and git stays a one-way projection (ADR-0018).

## Why the REST API, not git smart-HTTP

The existing git-sync panel pushes over git smart-HTTP via isomorphic-git —
which works against remotes that serve CORS, but **github.com's git endpoints
send no CORS headers**, so a browser cannot reach them. `api.github.com` does.
The GitHub path therefore projects the snapshot through the REST **Git Data
API** instead:

1. `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` — the parent commit.
   A `404` (new branch) or `409` ("Git Repository is empty") means the push
   creates the first commit (no parent) and creates the ref.
2. `POST …/git/blobs` — one UTF-8 blob per file.
3. `POST …/git/trees` — one full tree (no `base_tree`: the snapshot replaces
   the branch; nested paths are plain `a/b.typ` entries).
4. `POST …/git/commits` — parented on (1) when it existed. Exactly
   `{message, tree, parents}`: no author/committer is sent, so GitHub attributes
   both to the token owner (see *Attribution* below).
5. `PATCH …/git/refs/heads/{branch}` with `force: true` (or `POST …/git/refs`
   for a new branch). Force is honest: the remote is a mirror of the CRDT, not
   a merge participant.

The pushed tree is the **same materialized projection** the git-sync panel
pushes (`materializeProject`, including `.galley/project.json` and the
project's `.galley/instructions` when present), read back from the project's
persisted y-indexeddb CRDT updates — strictly read-only, so the live session's
persistence provider is undisturbed.

## Attribution on pushed commits

GitHub snapshot commits use the authenticated PAT owner as the linked author;
Galley records project contributors in `Galley-Contributor:` and
`Co-authored-by:` trailers, but synthesized `@users.galley.local` addresses do
not link those contributors to GitHub accounts or contribution graphs.

Concretely:

- **Author / committer** — neither is sent. The commit body is exactly
  `{message, tree, parents}`, so GitHub fills both from the authenticated token
  owner. Under the personal-PAT model that IS the person pushing, and it is a
  real, verified identity — avatar, profile link, contribution-graph credit.
  Supplying Galley's synthesized identity instead would trade all of that for an
  unlinkable address (and because an omitted `committer` defaults to the
  *author*, it would take both fields down).
- **Trailers** — `Galley-Contributor:` per distinct contributor (the source of
  truth Galley reads back), plus `Co-authored-by:` for every contributor other
  than the pusher, who already authors the commit. They are written by the same
  `encodeMessage` the local version store uses, so the remote and the local git
  projection cannot drift into two formats.

The trailers are a **record**, not GitHub credit. GitHub only connects a commit
author or a `Co-authored-by:` trailer to an account when the email is a
**verified email on that account**, and a synthesized `@users.galley.local`
address never is — so contributors named in trailers get no avatar, no profile
link, and no contribution-graph credit. Real GitHub identities need real
verified emails, which Galley does not have in local mode.

Display names come from collaborators (they are CRDT data), so they are treated
as untrusted input. Every trailer value is CR/LF-stripped, angle-bracket-stripped
and length-bounded before it reaches a commit, holding two invariants: a name
cannot forge a trailer line of its own, and each emitted `Co-authored-by:` line
carries **exactly one** `<…>` address — always the synthesized one. The second
invariant matters because a label like `Bob <ceo@company.com>` would otherwise put
a second address on the line, and which one a reader credits then depends on
whether its parser is greedy or lazy — which Galley does not control.

## Token handling (security posture)

- The PAT is stored in **this browser's localStorage only**
  (`galley.githubConnect`) and is sent to `api.github.com` directly — never to
  any Galley server.
- The token is **write-only from the screen**: the input is a password field
  that is cleared after every attempt; UI renders only the structurally
  token-free redacted view (login + repo + `hasToken`).
- Every surfaced error is token-scrubbed — the literal, URL-encoded, base64,
  and `Bearer …` wire forms (the `redactRemoteError` discipline, applied to the
  REST path in `github-api.ts`).
- Failures map to a small typed vocabulary (`bad-token` / `not-found` /
  `rate-limited` / `conflict` / `network` / `invalid` / `too-large`) so the UI
  shows honest copy, never raw wire text alone.
- The response text that is **parsed/surfaced** is capped (64 K chars). Honest
  scope: a parse/display cap, not an IO cap — the transport still reads the
  full response body before truncation.
- The push button loads the stored connection **once per click** and pushes to
  exactly what that load returned; the status line names that same target, so
  a selection changed in another tab can never make the push and the surfaced
  target diverge.

### Which token to create

- **Classic PAT**: the `repo` scope (also needed to create a repository from
  the settings section).
- **Fine-grained PAT**: *Contents: read & write* on the target repository
  (repo creation is not covered by fine-grained contents permissions).

## Caps and v0 limits (deliberate)

- Push only — no fetch/pull from GitHub (use the git-sync panel against a
  CORS-serving remote for round-trips).
- Text files only (the CRDT projection is text); snapshots are capped at 500
  files / 10 MiB, failing closed with a clear `too-large` error.
- One connection per browser, one repo selection at a time.
- A push moments after a burst of edits projects the state y-indexeddb has
  committed; in practice writes land per keystroke, so this matches the editor.
- The push-time materialize reads the project's whole stored update log
  (`getAll()`) **before** the snapshot caps apply — a very large local update
  history can cost memory/CPU at push time.
- No fetch/pull from GitHub remains v0 scope (the CRDT is the source of truth;
  the REST path is a one-way projection).

## Surfaces

| Surface | Where | Testids |
| --- | --- | --- |
| Connect / validate / disconnect | `/settings#github` | `settings-section-github`, `github-token-input`, `github-validate`, `github-login`, `github-disconnect` |
| Repo selection (owner/name/branch, create-new) | same section | `github-repo-owner`, `github-repo-name`, `github-repo-branch`, `github-repo-save`, `github-repo-create` |
| Manual push | project Git panel | `git-github-push` (rendered only when a connection exists — default-OFF) |

Code: `apps/web/src/github-api.ts` (pure REST client, injected fetch),
`apps/web/src/github-connect.ts` (storage seam), `apps/web/src/git-sync-ops.ts`
(`pushGithubSnapshot` + the IndexedDB materialize), e2e in
`apps/web/e2e/github-connect.spec.ts` (fully route-intercepted, offline).
