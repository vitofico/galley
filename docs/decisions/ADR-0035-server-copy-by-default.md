# ADR-0035 — A signed-in person's projects are kept on the server by default

- **Status:** Accepted. **Supersedes two clauses**, and only those:
  [ADR-0033](./ADR-0033-hosted-connector.md) §1 "A project that was never
  connected has no server copy" and its "default off, twice" as far as the
  _copy_ is concerned (the connector's own access stays off until a project is
  connected); [ADR-0034](./ADR-0034-connected-project-second-device.md) §3,
  where server copies are on: a project opened on a device that does not hold
  it is restored there as a full project, not joined as a guest.
- **Scope:** storage and durability; hosted connector.

## Context

On 2026-11-19 a person signed in to their own Galley instance cleared their
browser history and lost every document. The server had none of them. Signing
in had given them an account and nothing else: a project lived in one browser
profile's IndexedDB, and the only way onto the server was to connect it to the
hosted connector, one project at a time, which is an act about AI access, not
about keeping work.

Someone who signs in to a server reasonably expects the server to have their
work. A storage model in which the browser's "clear data" button is a delete
button for everything, with no warning at that moment, is a bug.

## Decision

### 1. On a signed-in deployment every project has a server copy

Where the web service runs with sign-in, the shared data volume and a relay
that persists rooms, every project a browser holds is synced into a durable
room on the relay, with no action from the person:

- when a project is open, over a second connection beside any Share
  connection, exactly as a connected project already was;
- when the library is open, for every held project in turn, from the document
  in browser storage. A project does not need opening to be on the server, so
  the first visit after an upgrade uploads the backlog.

The copy and the browser's document are two replicas of one Yjs document and
merge like two collaborators. There is still no server-authoritative document.

### 2. A copy is not a grant: a new room kind

The copy lives in a `copy` room, a fourth capability-room kind. It is
registered and revoked like the others and persisted by the relay like a
connector room, but the hosted connector, which only sees `connector` rooms,
cannot reach it. Keeping every project on the server must not hand every
project to every AI-client token of the account.

A project has one replica room. Connecting it turns its `copy` room into a
`connector` room in place; disconnecting turns it back. The stored document is
never emptied by either. Copies have their own limit (1024 per person) and
count toward neither the 128-room limit nor the 32 connected projects.

### 3. Opt-out, per project and per deployment

- **Per project:** "Keep only in this browser" in the project's menu revokes
  its room. The relay drops it and erases the stored copy within about half a
  minute. The account remembers this choice for the project across browsers. The registry serializes preference changes with copy registration. An explicit connector grant can still create a connector replica, which disconnect revokes when the project is opted out.
- **Per deployment:** the default follows the configuration. Copies are on
  when the web service has `GALLEY_AUTH_MODE=oidc`, `GALLEY_DATA_DIR` and
  `GALLEY_SYNC_PERSIST_DIR` (the web service cannot see the relay's
  environment, so the operator states the persist volume there too).
  `GALLEY_SERVER_COPY=0` turns them off; `=1` refuses to start where a
  prerequisite is missing.
- **Without an account** nothing changes and nothing is sent. The library and
  the editor say that the project exists only in this browser.

### 4. Restore makes the project whole

A signed-in browser that does not hold a project lists it under "On the
server". Opening it fetches the copy first, writes it to browser storage under
the same project id, adds it to the library and opens it at `/p/<id>`. No
starter content is ever seeded into it, which is what ADR-0034 feared from
this path. The project can then be shared, versioned and handed to an agent
like any other. `/c/<id>` remains for deployments that have the connector
without server copies.

### 5. Delete means delete

Deleting a project in the library first revokes its server copy and stops with
a message if that fails, then removes the library entry and the project's
document from browser storage. Before, the document database was left behind
and a server copy would have brought the project back.

### 6. The state is always visible

Each project says "Saved on this server", "Uploading" or "Only in this
browser" on its card and in the editor, permanently, not as a dismissible
notice. The app also asks the browser for durable storage on every page, not
only in the editor.

## What does not change

- **Local mode.** No account, no server copy, no request.
- **The connector's access.** Off for every project until it is connected.
- **Plain text at rest.** A copy is readable by whoever operates the server,
  as a connected project's replica already was. The interface says so.
- **Share links and Agent Access rooms.** Still never persisted under
  `GALLEY_SYNC_PERSIST_ROOMS=connector`, which now means "project replicas":
  copies and connector rooms.

## Consequences

- The privacy statement of a signed-in deployment is reversed: the server
  holds every project unless the person or the operator opts out. README, the
  security model and the self-host guide say so.
- Where hosted storage is configured, the replica includes live binary assets
  such as images and project fonts. The browser sends locally granted bytes
  through the quota-enforced hosted channel and verifies bytes on restore.
  A background upload on these deployments waits for the relay to confirm
  the local document's state vector has reached persistent storage.
  Other deployments keep a text copy. Existing text copies can recover text
  even when referenced bytes were never uploaded.
- Version history made in a browser stays in that browser. A restored project
  starts a new history.
- The library can recover a surviving registry entry from an earlier local
  profile on the same browser. Recovery requires choosing the project on the
  device and keeps it local by default. Clearing IndexedDB erases this option.
- A relay that was started without a persist volume while the web service
  claims one gives people a copy that vanishes when the relay restarts. The
  two settings must agree, as the connector's already had to.
- Disconnecting no longer erases the server copy on a deployment that keeps
  copies; opting the project out does. Connector checkpoints stay with the
  copy until then.

## Alternatives considered

- **Reuse the `connector` room for every project.** Smallest change, and it
  would have made every project readable by any connector token on upgrade.
- **Keep the ADR-0034 guest view as the restore.** The text would come back
  into a project that can never be shared, versioned or given to an agent.
- **An explicit operator opt-in.** The incident happened on a deployment whose
  operator had not thought to opt in. The default has to be the safe one.
