# Connecting an MCP client to Galley (the local kernel)

Galley ships a **local MCP kernel** (`@galley/mcp`, in `apps/mcp`) that lets an
external MCP client — Claude Code, or any other Model Context Protocol client —
read and propose edits to a Galley project. The kernel speaks MCP over **stdio**
and joins your project through the same sync relay your browser already uses.
It is **local-first and unauthenticated by design**: stdio reaches only the user
who spawned the process, and the kernel never invents access — it only *joins*
rooms whose unguessable ids the **browser** mints for you.

This guide walks through the two ways to connect. If you only want one project,
use **per-project mode**. If you want the agent to see your library and pick a
project, use **control mode**.

> Deep dives: [ADR-0020](decisions/ADR-0020-mcp-local-kernel.md) (the local
> kernel: sync-room peer + pending-proposal mailbox),
> [ADR-0021](decisions/ADR-0021-mcp-library-ops.md) (the browser-mediated Agent
> Access control room), and
> [ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md) (authenticated
> proposal provenance + opt-in auto-accept). This page is the *how-to*; the ADRs
> are the *why*.

---

## Prerequisites

- **A running Galley instance** — local dev (`pnpm dev`) or a deployed one. Open
  it in a browser; that browser tab is what the kernel talks to.
- **A running sync relay.** Galley's collaboration features and the kernel both
  ride the `apps/sync` relay. In local dev it listens on **`ws://localhost:1234`**
  by default (see [`server-and-collaboration.md`](server-and-collaboration.md)).
  In the co-located self-host profile the relay is reachable at
  `ws(s)://<your-galley-host>:1234`.
- **A project to work on**, open in that browser tab.
- **An MCP client** (e.g. Claude Code) that can launch a local stdio MCP server.
- The repo checked out, so you can run `pnpm --filter @galley/mcp start`. (A
  published `galley-mcp` binary is referenced in the kernel's own `--help`; from
  a source checkout, substitute `pnpm --filter @galley/mcp start --` for
  `galley-mcp` in every command below.)

> **Room ids are capabilities.** Both the share-room id (per-project mode) and
> the control-room id (control mode) are unguessable secrets minted by the
> browser. Anyone holding one can reach that scope — treat them like passwords.
> Don't paste them into shared logs or chat.

---

## Per-project mode (the primary flow)

The kernel joins **one shared project room**. Reads span the whole project; the
agent's writes are proposals — `propose_edit` (the session's bound file) or
`propose_files` (a multi-file create + edit change set). A proposal never edits
the document directly: it is **published for review** as a card in Galley (a
multi-file set lands all-or-nothing). By default it waits for a human **Accept**;
when **auto-accept** is armed (see below) a signed proposal applies automatically.
The tool **response reports the honest disposition** — `status:"applied"` once the
change has landed, `"rejected"` if a human rejected it, or `"pending_review"` when
no verdict has arrived yet (re-read with `read_document` / `list_files` to confirm)
— rather than assuming every proposal waits for a click.

### 1. Share the project to mint a room id

In Galley, with your project open, click **Share** (the `Share` button, top of
the project shell). This live-upgrades the local session to a shared room and
shows a join link in the Share popover, labeled *"Anyone with this link can
edit"*. Copy that link.

### 2. Extract the room id and the sync URL

The join link has the form:

```
https://<your-galley-host>/join/<room-id>
```

The **room id** is the path segment after `/join/`. For example, from
`https://galley.example/join/share-1b2c3d4e-...` the room id is
`share-1b2c3d4e-...`.

The **sync URL** is the relay your browser uses — by default the same host on
port `1234`: `ws://localhost:1234` in local dev, or
`wss://<your-galley-host>:1234` for a deployed HTTPS instance. (If your Galley
build sets a custom relay via `VITE_GALLEY_SYNC_URL`, or the share link carries
an explicit `?sync=…` override, use that exact value instead.)

The **file path** is the project-relative path of the file you want the agent
scoped to, with a leading slash — e.g. `/main.typ`. (If you omit the leading
slash the kernel adds one for you.)

### 3. Start the kernel

```bash
pnpm --filter @galley/mcp start -- \
  --sync ws://localhost:1234 \
  --room <room-id> \
  --file /main.typ \
  [--compile-url http://localhost:3001]
```

- `--sync` — the sync relay WebSocket URL (`ws://` or `wss://`).
- `--room` — the room id you extracted from the Share link.
- `--file` — the one file this session is scoped to (leading slash).
- `--compile-url` — **optional**; enables the `compile` tool by POSTing the
  document to a **loopback-only** compile service (default `http://localhost:3001`,
  see [`server-side-compile.md`](server-side-compile.md)). The kernel **refuses**
  any non-loopback URL because it would exfiltrate your document on every
  compile.

Env fallbacks exist for every flag (`GALLEY_MCP_SYNC`, `GALLEY_MCP_ROOM`,
`GALLEY_MCP_FILE`, `GALLEY_MCP_COMPILE_URL`); flags win over env. Run
`pnpm --filter @galley/mcp start -- --help` to print the kernel's own usage.

On success the kernel waits until the file has replicated, then logs to
**stderr**:

```
galley mcp kernel: joined room, /main.typ is live
galley mcp kernel listening on stdio (room configured: shar…(NN chars), file /main.typ, compile …)
```

(The room id is redacted to a non-reversible fingerprint in logs — that's
intentional.)

### 4. Connect your MCP client

The kernel is a **local stdio server**: a command your client spawns on your
machine, not a hosted endpoint.

> **Not the "Add custom connector" dialog.** claude.ai and Claude Desktop's
> *Settings → Connectors → Add custom connector* flow is for **remote** MCP
> servers and demands an `https://` URL — it will reject the kernel's command
> (and the `wss://` sync URL is the relay, not an MCP endpoint). Register the
> kernel as a **stdio** server instead, by one of the two methods below.

For **Claude Code**, add it from the CLI — everything after `--` is the command
Claude Code spawns:

```bash
claude mcp add galley -- pnpm --filter @galley/mcp start -- \
  --sync ws://localhost:1234 --room <room-id> --file /main.typ
```

(With a published `galley-mcp` binary on your PATH, drop the
`pnpm --filter @galley/mcp start --` and start the command at `galley-mcp`.)
Then `claude mcp list` to confirm it connects. Or add it to your MCP config by
hand (adjust the absolute path to your checkout):

```json
{
  "mcpServers": {
    "galley": {
      "command": "pnpm",
      "args": [
        "--filter", "@galley/mcp", "start", "--",
        "--sync", "ws://localhost:1234",
        "--room", "<room-id>",
        "--file", "/main.typ"
      ]
    }
  }
}
```

For **Claude Desktop**, add the same `mcpServers` block to
`claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`) and restart
the app.

> stdout carries the MCP protocol **exclusively** — every human-facing message
> goes to stderr — so your client can launch the kernel directly without log
> noise corrupting the stream.

### 5. The per-project tools

Once connected, the agent has these tools (all scoped to the shared project):

| Tool | What it does |
| --- | --- |
| `read_document` | Read the live text of the scoped file. |
| `list_files` | List the project's files. |
| `read_file` | Read any project file by exact path (read-only). |
| `project_context` | Query-relevant excerpts across all files, with provenance. |
| `propose_edit` | Publish a **pending** search/replace proposal for the scoped file (never writes). |
| `propose_files` | Publish a **pending** multi-file change set — create new files and/or edit existing ones, applied all-or-nothing (never writes). |
| `compile` | Type-check via the loopback compile service (needs `--compile-url`). |

**The Accept gate is mandatory.** `propose_edit` and `propose_files` apply their
edits to a scratch copy and publish the result as a pending proposal — they
*never* mutate the project. In Galley the proposal appears as a review card (a
multi-file set shows one read-only diff per file under a single **Accept all** /
**Reject**); a human decides. Accept applies it to the live CRDT — a multi-file
set lands atomically and never overwrites edits made meanwhile (a conflict
surfaces and the set stays pending); reject discards it. The agent cannot bypass
this.

`propose_files` ops are `{ kind: "create", path, text }` or
`{ kind: "edit", path, edits: [{ search, replace }] }`; paths must be safe
in-tree project paths (leading slash, no traversal, not under `/.galley`), and
the change set is bounded (max ops, total bytes) — over-limit or conflicting
requests come back as structured data to refine, never a crash.

---

## Control mode (list projects from the kernel)

Control mode joins the browser's **Agent Access** control room and lets the
agent ask the browser to *list* projects/versions (metadata only), *read* the
files of projects you've **explicitly granted file access** (per-project,
session-scoped — see step 4), and *open* a chosen project (with your explicit
per-request approval). Opening a project hands the session over to the
per-project machinery above.

### 1. Enable Agent Access in the browser

Open **Settings → Agent Access**. It is **off by default**. Click **"Enable for
this session"**. The browser mints a fresh, session-scoped **control room** plus
a per-session **response-authentication key**, starts the responder, and shows a
copyable **pairing command** carrying a **one-time pairing code** (B2,
[ADR-0026](./decisions/ADR-0026-mcp-durable-pairing.md)) — **no secret**:

```
galley-mcp --sync <sync-url> --pairing-code <code>
```

Click **Copy**. (From a source checkout, replace the leading `galley-mcp` with
`pnpm --filter @galley/mcp start --`.) The code is **one-time** and **expires in
10 minutes**. When the kernel runs, it derives a temporary pairing room + keys
from the code (HKDF), proves it knows the code (a MAC, never the code itself), and
runs an authenticated **ephemeral-ECDH** exchange to receive the control room +
response key over an **AES-256-GCM-sealed, forward-secret** channel — so the
long-lived response key **never rides in argv** (shell history / process listings /
logs), and even a recorded handshake plus a later code leak cannot recover it. When the deployment exposes a **loopback** compile service
(e.g. the `docker-compose.compile.yml` overlay serving
`http://127.0.0.1:3001/compile`), the copied command **auto-includes
`--compile-url`**; a remote/absent compile URL is omitted (the kernel only POSTs
the document to a loopback service), and you can still add `--compile-url` by
hand. The code is bearer material for its 10-minute, one-time window; once the
kernel pairs (or 10 minutes pass) it is inert. Agent Access is scoped to **this
browser tab** and revocable — clicking **Revoke** tears the responder down (and
destroys the key); the next Enable mints a brand-new room, key, and code.

**Durable pairing.** After a successful handshake the kernel stores the obtained
room + key under `${XDG_STATE_HOME:-$HOME/.local/state}/galley/kernel/pairing.json`
(dir 0700, file 0600, integrity-MAC'd with a local-only key so a copied file fails
on another machine). **Later kernel runs need no re-paste** — run `galley-mcp
--sync <url>` (or with the same `--pairing-code`, which is ignored when a valid
durable pairing exists). Re-pair only after a Revoke.

### 2. Start the kernel in control mode

Paste the pairing command (adapted for your checkout):

```bash
pnpm --filter @galley/mcp start -- \
  --sync ws://localhost:1234 \
  --pairing-code <code> \
  [--compile-url http://localhost:3001]
```

`--room`/`--file`, `--pairing-code`, and `--control-room`/`--response-key` are
**mutually exclusive** — a kernel runs in *either* per-project *or* control mode,
and control mode pairs with *either* a one-time code (B2) *or* the legacy room+key
(CI/manual; **memory-only, never written to the durable store**), never both.
After the first successful code handshake, omit `--pairing-code` on later runs —
the durable pairing resumes automatically. Control mode does **not** wait for a
responder at startup; it logs and serves immediately:

```
galley mcp kernel listening on stdio (control room configured: …, compile …) — open Galley and enable Agent Access to answer this session
```

### 3. Connect your MCP client and use the control tools

Connect exactly as in per-project step 4, but with `--control-room` instead of
`--room`/`--file`. The control tools are:

| Tool | What it does |
| --- | --- |
| `list_projects` | The browser returns its projects' metadata (id, name, lastModified). |
| `list_versions` | One project's named-version metadata (no file contents). |
| `open_project` | Asks the browser to open a project; it mints a share room (plus a per-grant `grantId` for proposal provenance) and the kernel joins it. |
| `search_project` | Searches a **file-access-granted** project's files for literal text (see step 4). |
| `list_files` | Lists a **granted** project's file paths. |
| `read_file` | Reads one file of a **granted** project by path (read-only, line-numbered). |
| `list_bibliography` | Lists a **granted** project's bibliography — every `.bib` file, de-duplicated, as compact one-line entries (read-only). Prefer it over `read_file` for a bibliography, which is often too large to read whole. Only BibTeX `.bib`, **not** Hayagriva `.yml`. |

**`open_project` requires your approval.** When the agent calls it, the browser
shows a **blocking confirmation** and only opens the project — *visibly* — after
you approve. It's limited to one project per kernel run: after a successful
`open_project`, the per-project tools (`read_document`, `list_files`,
`read_file`, `project_context`, `propose_edit`, `propose_files`, `compile`) become available
scoped to that project's main file, and further `open_project` calls fail until
you restart the kernel. (The control-mode `search_project`/`list_files`/
`read_file`/`list_bibliography` tools above are retired at that point — the
per-project versions of `list_files`/`read_file` take over. There is **no**
per-project `list_bibliography`: after `open_project` that tool is gone until you
restart the kernel — read a `.bib` with `read_file`, or take the compact list
before opening. This asymmetry is deliberate.)

**Opt-in auto-accept (off by default).** Each `open_project` mints a per-grant
`grantId` that binds proposal **provenance**: the kernel HMAC-signs every proposal
it publishes and the browser verifies it. By default every proposal still waits for
your manual **Accept**. You may *arm* **auto-accept** for a room (per-grant, OFF by
default, never for a viewer): signed, conflict-clean proposals then apply without a
click — each preceded by a revertable **checkpoint** and recorded in a durable
**audit trail**. An always-visible **"Auto-accept ON"** banner offers an instant
**kill-switch**, and the grant **re-binds across a page reload** so a reloaded tab
is never silently stranded. See
[ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md) for the design.

### 4. Grant file access per project (the read-only tools)

Pairing alone is **metadata-only**: `search_project`, `list_files`, and
`read_file` answer **only for projects you explicitly granted file access**,
and every call must name a `projectId` from `list_projects`. Granting happens
in the browser, never from the agent side:

1. In **Settings → Agent Access** (while enabled), each local project is listed
   with an **"Allow file access (this session)"** button.
2. Clicking it grants the paired agent **read access to every file in that
   project** for this browser session. The agent still cannot edit anything —
   edits always go through the per-project `propose_edit` + your Accept review.
3. Grants are **session-scoped and revocable**: revoke a single project's grant
   in the same list, or click **Revoke** on Agent Access to clear the pairing
   *and* every grant at once. Closing the tab clears them too. The default is
   always **zero grants**.

Until you grant a project, the agent's calls fail with a `consent-required`
error telling it (and you) where to grant.

For exactness: behind the grant, the **browser responder** answers every
*read-only* registry op over the control mailbox — `search_project`,
`list_files`, `read_file`, `list_bibliography`, plus `read_document` (mapped to
the granted project's **main file**) and `compile` (always refused: no compiler
exists on this surface — it fails closed with a generic error). The kernel only
*registers* the first four as MCP tools; the other two are reachable only by
a client speaking the mailbox protocol directly, carry the same consent gate,
and expose nothing beyond what the grant already covers. Mutating ops
(`propose_edit`) are refused outright on this surface.

---

## Troubleshooting

**`timed out waiting for /<file> in room …`**
The kernel joined but the file never replicated within the timeout. Check that:
the project is actually **shared** (click Share so the room exists and is live),
the **room id** matches the one from the Share link exactly, and the **file
path** exists in the project (with a leading slash, e.g. `/main.typ`). Keep the
Galley tab open — the kernel mirrors what the browser is syncing.

**`no responder answered '<op>' within …ms`** (control mode)
No Agent Access responder is listening on that control room. Open Galley in the
browser and make sure **Settings → Agent Access** is **Enabled** for the tab
holding the control room you paired with. If you revoked and re-enabled, the
room id changed — re-copy the pairing command and restart the kernel.

**`the responder refused this request`** (control mode)
The browser declined the request — e.g. you rejected the `open_project`
confirmation, or asked for a project that isn't in the library. The kernel
deliberately reports every refusal with this one generic line (responder text is
never relayed to the MCP client); the browser side shows the specifics. Re-run
with a valid `projectId` from `list_projects`, and approve the confirmation.

**The kernel times out even though Galley is open and enabled** (control mode)
Responses without a valid `--response-key` signature are ignored. If you clicked
Revoke and re-enabled Agent Access, the room **and the key** changed — re-copy
the full pairing command and restart the kernel with it.

**`… the browser has not granted file access for project …`** (control mode)
The agent called `search_project`/`list_files`/`read_file` for a project you
haven't granted. In Galley, open **Settings → Agent Access** and click
**"Allow file access (this session)"** next to that project, then retry. Grants
are per-project, per-session, and default to zero.

**Connection refused / the kernel exits at startup with a flag error**
The kernel **fails loud** on bad config — the error names the exact flag. A
connection that can't reach the relay usually means the **sync relay isn't
running** or the **`--sync` URL is wrong** (wrong host, wrong port, or `ws://`
vs `wss://` mismatch with an HTTPS page). Confirm the relay is up
(`pnpm --filter @galley/sync start`, listening on `:1234`) and that `--sync`
matches the relay your browser uses.

**`--compile-url must be a loopback URL …`**
The compile service URL must point at `localhost`, `127.0.0.0/8`, or `::1`, with
no embedded credentials. The kernel POSTs the document there on every `compile`,
so a non-loopback host is refused to prevent exfiltration. Start a local compile
service (`pnpm --filter @galley/compile start`, default `:3001`) and use
`http://localhost:3001`.

---

## Examples (copy-paste)

**Per-project, no compile:**

```bash
pnpm --filter @galley/mcp start -- \
  --sync ws://localhost:1234 \
  --room share-1b2c3d4e-... \
  --file /main.typ
```

**Per-project, with compile diagnostics:**

```bash
pnpm --filter @galley/mcp start -- \
  --sync ws://localhost:1234 \
  --room share-1b2c3d4e-... \
  --file /main.typ \
  --compile-url http://localhost:3001
```

**Control mode (from the browser's pairing command, source checkout):**

```bash
pnpm --filter @galley/mcp start -- \
  --sync ws://localhost:1234 \
  --control-room share-9f8e7d6c-... \
  --response-key dGhpcy1pcy1ub3QtYS1yZWFsLWtleS1jb3B5LXlvdXJz
```

**Deployed HTTPS instance (secure relay):**

```bash
pnpm --filter @galley/mcp start -- \
  --sync wss://galley.example:1234 \
  --room share-... \
  --file /main.typ
```

---

## See also

- [`decisions/ADR-0020-mcp-local-kernel.md`](decisions/ADR-0020-mcp-local-kernel.md) — the local kernel design.
- [`decisions/ADR-0021-mcp-library-ops.md`](decisions/ADR-0021-mcp-library-ops.md) — the Agent Access control room.
- [`decisions/ADR-0023-mcp-auto-accept-provenance.md`](decisions/ADR-0023-mcp-auto-accept-provenance.md) — authenticated proposal provenance + opt-in auto-accept.
- [`server-and-collaboration.md`](server-and-collaboration.md) — the sync relay, rooms, and presence the kernel rides on.
- [`server-side-compile.md`](server-side-compile.md) — the opt-in compile service `--compile-url` points at.
- [`editing-and-diff.md`](editing-and-diff.md) — the search/replace + Accept-gate contract `propose_edit` uses.
- [`security-model.md`](security-model.md) — trust boundaries and per-surface posture, including the MCP surfaces.
