# ADR-0034 — A connected project opens on its owner's other devices

- **Status:** Accepted. **Extends** [ADR-0033](./ADR-0033-hosted-connector.md)
  (hosted connector). Does **not** supersede it: the grant, the token, the two
  review modes and the server applier are unchanged. Only the answer to "this
  browser does not hold the project" changes.
- **Scope:** roadmap #16 (MCP), hosted connector.

## Context

The hosted connector exists so a person can say "tighten chapter 3" from a chat
app on a phone. Having said it, they could not look at the result on that
phone. A project lives in the browser that created it, so Galley on any other
device shows an empty library.

Everything needed was already on the server. A connected project has a full
replica in its connector room, and the signed-in person can list their own
connector rooms. But the app attached to that replica only when a local project
with the same id was open, and Settings listed such a project as "(not on this
device)" with a Disconnect button and nothing else. The one way to open it
elsewhere was a Share link, which needs the holding browser open at that
moment: the opposite of what the connector is for.

## Decision

### 1. `/c/<project id>` opens your own connected project

The address names the project, not its room. Behind sign-in, the app asks the
existing `GET /auth/connector/projects` for the caller's connected projects,
finds the one with that id and joins its connector room as an editor, on the
same path a Share guest takes. There is no new server route and no change to
the relay.

The library lists connected projects this device does not hold, and Settings
gains an "Open" action beside "(not on this device)". Both lead to this address.
A browser that does hold the project is sent to its usual `/p/<id>` instead, so
there is never a second, lesser view of a project next to the real one.

### 2. The room id stays where ADR-0033 put it

A connector room id is a capability with no expiry: whoever has it can read and
write the server copy. It is still handed only to its creator's signed-in
session, by the one route that echoes it, and held in memory.

- It is not in the address, so not in history, bookmarks, synced tabs or a
  share sheet. The project id that is there opens nothing without the session.
- The device's cached copy is stored under the project id, not the room id, so
  the room id is not written to browser storage.
- The Share control is not offered in such a session. Sharing stays an act of
  the browser that holds the project, with a room of its own.

### 3. The other device reviews by hand

It reads, edits text and accepts or rejects proposals. It is a joined session,
so the rules that already bind one apply unchanged: a proposal from an AI client
is never applied there automatically, it cannot hand the project to a local
agent, and it keeps no version history of its own. Standing authority (Auto in the browser, version
restore) stays with the browser that holds the project; the server's own Auto
mode is unaffected.

## What does not change

- **Default off, twice.** Nothing here runs unless the operator enabled the
  connector and the person connected the project.
- **Who can obtain a room id.** Its signed-in creator, as before.
- **The server copy.** No new data is stored on the server and nothing is
  stored longer.
- **Local mode and Share links.** Neither is touched.

## Consequences

- **A signed-in session opens every connected project of that account.** This
  was already true for anyone who called the route and the relay by hand; it is
  now a tap. Signing in on a device you do not control exposes your connected
  projects there, which the Settings text says.
- **The device keeps a cached copy** of what it opened, in browser storage, like
  a Share guest's cache. Signing out or disconnecting the project does not erase
  it; clearing the site's data does.
- **Text only.** The server copy carries no images or project fonts (ADR-0033),
  so a project that uses them renders without them here until hosted blobs are
  wired in.
- **Empty until filled.** The server copy fills when the holding browser has the
  project open. A project connected but not opened since shows nothing yet, and
  the page says why.
- **Relay role enforcement** is still missing. Not made worse: this device is
  the owner.

## Alternatives considered

- **Create a full local project on the second device** under the same id and let
  the existing replica link fill it. Rejected for now: a new local project is
  seeded with starter content that would merge into the server copy, and the
  device would become a second owner with its own history and its own automatic
  accept. It may return later as an explicit "keep on this device".
- **Put the room id in a link** (`/join/<room>`). Rejected: it writes a
  capability that never expires into history and share sheets, and it is what
  ADR-0033 ruled out by keeping connecting and sharing apart.
- **Exchange the project id for a short-lived room ticket.** The stronger
  design, because the device would never hold the room id at all. Deferred: the
  relay admits a capability room by its id, so a ticket needs a relay change,
  and belongs with relay role enforcement.
