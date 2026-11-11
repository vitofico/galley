# Use your own coding agent with Galley

Galley has a built-in agent, and it needs a provider API key. Every draft, every
revision, every compile-error explanation is billed per token against that key.

It does not have to work that way. Galley ships a **local MCP kernel** that
carries no model at all: no provider, no API key, no inference. It is a bridge.
It exposes your Galley project as a set of tools to whatever agent you already
run, and that agent does the thinking on whatever plan you already pay for. If
you have Claude Code or Codex open in another terminal, you already have
everything you need.

The split is worth stating plainly, because it is the whole point:

| | Built-in agent | Your own agent over MCP |
| --- | --- | --- |
| Where the model runs | Galley calls the provider | Your MCP client calls it |
| What it costs | Per-token, against your API key | Whatever your client already costs you |
| What Galley needs from you | A provider key, stored in the browser | Nothing. The kernel holds no secrets |
| Who sees your document | The provider you configured | Your client's provider, and nothing else |

What Galley contributes is the part a general coding agent does not have: the
live document, the file tree, real Typst diagnostics, and a review gate that
stops an agent from silently editing your work.

> **Two ways in.** This page covers the **local bridge**: a program on your
> machine, paired with an open Galley tab, where your browser applies every
> change. A second way, the **hosted connector** (an address on your Galley
> server that works with no tab open), is being built in steps
> ([ADR-0033](decisions/ADR-0033-hosted-connector.md)). So far, on a signed-in
> deployment whose operator enabled it, a client holding an access token can
> read a project you connected (list, read, search, compile) and **change
> it**. You choose how per project: in **Ask** a change waits for your Accept
> in Galley; in **Auto** the server applies it with no tab open, after saving
> a checkpoint you can return to from the project's History. You connect a
> project and create the token in **Settings →
> Agent Access → Hosted connector**, which also shows the address to give the
> client; operators see
> [`self-host.md`](self-host.md#hosted-connector-connected-projects).

> **This is a how-to.** For the exhaustive reference, including every flag,
> control-mode detail and troubleshooting case, see
> [`mcp-kernel-setup.md`](mcp-kernel-setup.md). For the reasoning behind the
> design, see [ADR-0020](decisions/ADR-0020-mcp-local-kernel.md),
> [ADR-0021](decisions/ADR-0021-mcp-library-ops.md),
> [ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md) and
> [ADR-0026](decisions/ADR-0026-mcp-durable-pairing.md).

---

## What your agent can do

Once connected to a project, your agent gets these tools:

| Tool | What it does |
| --- | --- |
| `read_document` | Read the live text of the file this session is scoped to. |
| `list_files` | List the project's files. |
| `read_file` | Read any project file by exact path. Read-only. |
| `project_context` | Pull query-relevant excerpts across all files, with provenance. |
| `propose_edit` | Publish a **pending** search/replace proposal. Never writes. |
| `propose_files` | Publish a **pending** multi-file change set, applied all-or-nothing. Never writes. |
| `compile` | Type-check through a loopback compile service. Requires `--compile-url`. |

## What it cannot do

**It cannot edit your document.** This is structural, not a setting. `propose_edit`
and `propose_files` apply their changes to a scratch copy and publish the result
as a pending proposal. In Galley it appears as a review card with a read-only
diff, and a human clicks **Accept** or **Reject**. A multi-file set lands
atomically or not at all, and never overwrites edits you made in the meantime: a
conflict surfaces and the set stays pending.

The tool response tells your agent the honest outcome, `applied` or `rejected` or
`pending_review`, rather than pretending every proposal is waiting for a click.

You can opt into **auto-accept** per grant if you want the loop to run unattended.
It is off by default, never available to a viewer, and when armed each applied
proposal is preceded by a revertable checkpoint, recorded in a durable audit
trail, and flanked by an always-visible banner with a kill switch.

---

## Quick start

You need a running Galley, a running sync relay (`ws://localhost:1234` in local
dev), a project open in the browser, and a checkout of this repo.

### 1. Install the `galley-mcp` command

The kernel ships as this repo's `galley-mcp` bin, but it is not published to npm
yet, so a fresh machine has no such command. Install it once from your checkout:

```bash
cd apps/mcp && pnpm link --global
```

If pnpm reports it has no global bin directory, run `pnpm setup` once (it creates
that directory and adds it to your PATH), then repeat the link. If you would
rather not touch pnpm's global state, a plain symlink works just as well:

```bash
ln -s "$PWD/apps/mcp/bin/galley-mcp.mjs" /usr/local/bin/galley-mcp
```

Either way, `galley-mcp --help` should now work from any directory. The bin runs
the TypeScript source through tsx rather than a build output, so it never goes
stale after a `git pull`.

> Prefer not to install anything? Every command below also works as
> `pnpm -C /path/to/galley --filter @galley/mcp start -- …` with the same flags.
> Use `-C` with an absolute path rather than `--filter` alone, because your MCP
> client will not spawn the kernel with this repo as its working directory.

### 2. Mint a room

Open your project in Galley and click **Share**. This upgrades the local session
to a shared room and shows a join link:

```
https://<your-galley-host>/join/share-1b2c3d4e-...
```

The **room id** is the segment after `/join/`. Copy it.

The **sync URL** is the relay your browser already uses: `ws://localhost:1234` in
local dev. On a deployed instance it is whatever the operator configured, which
is often a path such as `wss://<your-host>/sync` rather than a port.

You do not have to work it out. Every command below accepts `--url` in place of
`--sync`: pass the address you open Galley at, for example
`--url https://galley.example.com`, and the kernel reads the relay from that
site's own `/config.js`, the same file your browser reads.

> Room ids are capabilities, not names. Anyone holding one can reach that
> project. Treat them like passwords, and keep them out of shared logs and chat.

### 3. Register the kernel with your client

**Claude Code:**

```bash
claude mcp add galley -- galley-mcp \
  --sync ws://localhost:1234 --room share-1b2c3d4e-... --file /main.typ
```

Confirm with `claude mcp list`.

**Codex:**

```bash
codex mcp add galley -- galley-mcp \
  --sync ws://localhost:1234 --room share-1b2c3d4e-... --file /main.typ
```

Confirm with `codex mcp list`. Or write it into `~/.codex/config.toml` by hand:

```toml
[mcp_servers.galley]
command = "galley-mcp"
args = [
  "--sync", "ws://localhost:1234",
  "--room", "share-1b2c3d4e-...",
  "--file", "/main.typ",
]
```

**Claude Desktop:** add the equivalent `mcpServers` block to
`claude_desktop_config.json` (on macOS,
`~/Library/Application Support/Claude/claude_desktop_config.json`) and restart.

> Register it as a **stdio** server, which is a command your client spawns
> locally. The "Add custom connector" dialog on claude.ai is for remote servers
> and wants an `https://` URL. It will reject this, and the `wss://` sync URL is
> the relay, not an MCP endpoint.

### 4. Work

Ask your agent to read the document and suggest something. Its proposals show up
in Galley as review cards. You accept or reject them.

Keep the Galley tab open. The kernel mirrors what the browser is syncing, so a
closed tab means nothing replicates.

---

## Letting the agent choose the project

Per-project mode scopes the kernel to one room you minted by hand. **Control
mode** instead lets the agent list your library and ask to open something.

Enable it in **Settings → Agent Access**, which is off by default. Galley mints a
session-scoped control room and shows a pairing command carrying a **one-time
code** that expires in 10 minutes. The code is not the secret: the kernel uses it
to run an authenticated ECDH handshake and receives the real key over a sealed,
forward-secret channel, so the long-lived key never appears in argv, shell
history, or process listings.

```bash
galley-mcp --sync ws://localhost:1234 --pairing-code <code>
```

After a successful handshake the kernel stores the pairing under
`${XDG_STATE_HOME:-$HOME/.local/state}/galley/kernel/pairing.json`, so later runs
need no re-paste. Re-pair only after you click Revoke.

Three things stay under your control:

- **Listing is metadata only.** `list_projects` returns ids, names and
  timestamps. Nothing else.
- **Reading requires a per-project grant.** `search_project`, `list_files`,
  `read_file` and `list_bibliography` answer only for projects where you clicked
  **"Allow file access (this session)"** or approved project access. The default
  is zero grants.
- **Approve project access once.** The first `open_project` for a new scope shows
  one dialog for file access, Ask/Auto review mode, and optional background access.
  Ask is the default; background access starts off. Matching approved grants are
  reused on reconnect and reload. Revoke or changed access requires approval again.
  One project per kernel run; reopening that same project succeeds without a prompt.

`create_project` returns `projectPath` and `nextAction: "open_project"`. You do
not have to open the project yourself: when `open_project` names a project that
is not the one on screen, the paired tab shows the approval dialog over whatever
it has open and, on approval, switches to that project
([ADR-0032](decisions/ADR-0032-mcp-open-switches-project.md)). Denying leaves the
tab where it was. `status: "open_required"` now only appears when Galley could
not make the switch itself.

Binary uploads require a compatible web app and sync relay. The kernel checks
the browser's `galley-blob-v1` capability before sending bytes. An older browser
returns `binary_protocol_unsupported` with an update/reload instruction, without
publishing a partial proposal. Failed transfers release their reservations.

---

## Security in short

- **stdio, not a network service.** The kernel reaches only the user who spawned
  it. There is no port to expose and nothing to authenticate against.
- **The kernel invents no access.** It joins rooms whose unguessable ids the
  browser minted. It cannot enumerate, guess, or widen scope.
- **`--compile-url` must be loopback.** The kernel POSTs your document there on
  every compile, so a non-loopback URL is refused outright to prevent
  exfiltration.
- **Agent Access is per-tab, session-scoped and revocable.** Revoke tears down
  the responder and destroys the key. The next Enable mints a fresh room, key and
  code.

The full trust boundaries are in [`security-model.md`](security-model.md).

---

## If it does not work

| What you see | What it means |
| --- | --- |
| `timed out waiting for /<file> in room …` on stderr, or `/<file> has not replicated …` from a tool | The room id is wrong, the file path does not exist, or the Galley tab is closed. The kernel keeps running, so the next call works once the file syncs. |
| `no responder answered '<op>' within …ms` | Agent Access is not enabled in the tab, or you revoked and the room id changed. |
| `the responder refused this request` | The browser declined. You rejected the confirmation, or named a project that is not in the library. |
| `… has not granted file access for project …` | Grant it in Settings → Agent Access, per project. |
| `--compile-url must be a loopback URL …` | Point it at `localhost`, `127.0.0.0/8` or `::1`. |
| A flag error at startup | The kernel fails loud and names the exact flag. |

Every human-facing message goes to **stderr**; stdout carries the MCP protocol
exclusively, so log noise never corrupts the stream.

Longer diagnoses live in
[`mcp-kernel-setup.md`](mcp-kernel-setup.md#troubleshooting).
