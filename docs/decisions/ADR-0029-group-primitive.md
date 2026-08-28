# ADR-0029 — Minimal Group primitive (group-owned projects + group-aware authorization)

- **Status:** Accepted (2026-07-17).
- **Context:** a private downstream (galley-cloud) needs to build Organizations —
  teams of users who collectively own projects — and an AGPL self-hoster running a
  shared lab wants the same "a group of people, one set of projects" shape. Rather
  than let each consumer invent its own team model over the persistence seams, this
  ADR lands the smallest primitive that both can build on, entirely additive and
  default-absent. **galley references no cloud concept anywhere** — this is a
  self-host-useful building block that the hosted product happens to extend.

## Context

The persistence seams (ADR-0018) model a project as owned by one `UserId`, with a
membership map (`owner`/`editor`/`viewer`) and a membership-backed `Authorizer` at
the sync-ws edge. There was no notion of a *group* of users, so "everyone on the
team can open every team project" could only be expressed by adding each user to
each project individually.

This slice adds a `Group` primitive alongside `Project` — deliberately minimal, so
that the richer concepts (org billing, nested teams, invitations, seat limits) live
in the consumer, not in galley. The relay/server is **not** wired to the new
authorizer in this slice; that enablement is a deliberate follow-up (see Non-goals).

## Decision

### The shape (`@galley/shared` → `groups.ts`)

```ts
export type GroupId = string;
export type GroupRole = "admin" | "member";
export interface Group { id: GroupId; name: string; }
export interface GroupMember { userId: string; role: GroupRole; }

export interface GroupStore {
  createGroup(name: string, adminUserId: string): Promise<Group>;
  getGroup(id: GroupId): Promise<Group | null>;
  addMember(groupId: GroupId, userId: string, role: GroupRole): Promise<void>;
  removeMember(groupId: GroupId, userId: string): Promise<void>;
  getMembership(groupId: GroupId, userId: string): Promise<GroupRole | null>;
  listMembers(groupId: GroupId): Promise<GroupMember[]>;
  listGroupsForUser(userId: string): Promise<Group[]>;
}
```

`GroupStore` is modeled directly on `ProjectStore`: same per-id conventions, same
"creator is seeded as the privileged member" rule, same store-owns-membership split.

### Roles: `admin` | `member`

Two roles only. `admin` may administer the group (add/remove members, promote and
demote); `member` belongs to it. This is intentionally coarser than the project
roles (`owner`/`editor`/`viewer`) — a group is a *membership set*, and finer
per-project capability still comes from the project membership map. The group-aware
authorizer treats **both** roles as "can access the group's projects": **role gates
administration, not access.**

### The last-admin invariant — enforced at BOTH mutation points

A group must never become admin-less (an ownerless team is unrecoverable). The
store enforces this uniformly:

- `createGroup` seeds its creator as the sole `admin`.
- `removeMember` **refuses** to remove the last remaining admin.
- `addMember` **refuses** to demote the last remaining admin to `member`.

Enforcing it at only one of the two mutation points would leave the invariant
trivially bypassable (remove-guarded but demote-open, or vice-versa), so the
conformance contract pins **both** refusals against every adapter.

### `addMember` upserts

Adding an already-present member updates their role (it never duplicates), subject
to the last-admin rule above. This mirrors `ProjectStore.addMember`'s upsert and is
the least-surprising re-add semantic. (The alternative — reject a re-add — was
rejected: it forces callers to remove-then-add for a simple role change and buys
nothing.)

### Read paths never throw on an unknown group

`getGroup` → `null`, `getMembership` → `null`, `listMembers` → `[]`,
`listGroupsForUser` → `[]`, and `removeMember` is a no-op — mirroring the
`ProjectStore` posture so an unknown/legacy id is a benign miss, not an error.
(The filesystem adapter still rejects a *traversal* id before any FS access, as
`FsProjectStore` does.)

### Group-owned projects: `Project.ownerGroupId?`

`Project` gains one additive optional field, `ownerGroupId?: GroupId`, and it is
patchable through the existing `ProjectPatch`/`applyProjectPatch` machinery (a
one-line addition on the established metadata-patch path). Assigning a project to a
group is thus a deliberate, auditable metadata mutation — the same path a rename
takes — rather than a hidden side channel. A project written before groups existed
simply lacks the field (`absent = personally owned, no group`; no migration).

**Additivity is pinned:** a group-less project has no `ownerGroupId` key and its
JSON projection carries no slot (`in-memory.test.ts`), so existing self-hoster
on-disk state and every server adapter are byte-for-byte unchanged.

### Composing authorizer — `membershipAuthorizer` stays immutable

`membershipAuthorizer` (project-only) is **not touched** — its security semantics
are frozen. Group awareness is a **new, explicitly-named** function in the same
file:

```ts
projectOrGroupMembershipAuthorizer(projects: ProjectStore, groups: GroupStore): Authorizer
```

Both stores are **required** so a consumer wires an unmistakably group-aware
authorizer (never an accidental fall-through). Semantics:

1. **Direct project membership short-circuits** — checked first; when the user is
   already a project member the group store is never consulted.
2. Otherwise, if the project exists AND has an `ownerGroupId`, allow iff the user is
   a member (any role) of that group.
3. Unknown project ⇒ deny; a project with no owning group ⇒ deny (for a non-member).
4. **Fail closed:** any store error denies (`false`) rather than propagating.

Point 4 is a *deliberately stronger* posture than `membershipAuthorizer` (which
lets a store error propagate): a composing authorizer touches two stores at the
ws-upgrade edge, and a group-store hiccup must deny access — never crash the
upgrade, never fail open.

### Adapters

`InMemoryGroupStore` (Maps, injectable `IdGenerator` — deterministic for tests) and
`FsGroupStore` (`groups/<id>/group.json` + `members.json`, per-id `KeyedMutex`,
atomic temp+rename writes, `SAFE_KEY` traversal gate, corrupted-JSON propagation)
mirror `InMemoryProjectStore`/`FsProjectStore` exactly. A single `groupStoreContract`
proves both behave identically, and drives the fs adapter's reopen-durability block.

## Consequences

- galley-cloud can build Organizations directly on `GroupStore` + `ownerGroupId` +
  `projectOrGroupMembershipAuthorizer`, and a self-hoster gets working shared-lab
  groups with no cloud dependency.
- The sync relay still uses `membershipAuthorizer`; switching a deployment to the
  group-aware authorizer is a one-line wiring change in the server config, deferred
  to a follow-up so this slice ships types + stores + authorizer with zero behavior
  change on the running server.
- One additive optional field on `Project`; no migration; no change to any existing
  adapter or test's byte-level output for group-less data.

## Non-goals

- **Wiring the relay** to `projectOrGroupMembershipAuthorizer` — deliberate
  follow-up (`apps/sync/server-config.ts` is owned by another lane this wave).
- Nested/hierarchical groups, group-of-groups, or per-project group roles.
- Invitations, seat/quota limits, billing, or any org-lifecycle concept (consumer).
- Group-scoped versions, blobs, or settings.
- A dedicated `createProject({ ownerGroupId })` argument — group ownership is set via
  the metadata patch; a bespoke create arg can come with the consumer if wanted.

## Alternatives considered

- **Mutate `membershipAuthorizer` to be group-aware** — rejected. It would change
  the security semantics of the one authorizer the server already trusts; a new,
  explicitly-named composing function keeps the old path immutable and makes the
  group-aware choice a visible, deliberate wiring decision.
- **A single `roles: string[]` per member instead of one `GroupRole`** — rejected as
  over-engineered for a minimal primitive; two roles cover admin-vs-belongs, and the
  consumer can layer capabilities on top.
- **Leave `ownerGroupId` off the patch path** (a bespoke reassignment method only) —
  rejected. Reassignment via the standard metadata patch is a clean one-liner, keeps
  the field actually settable by a self-hoster (not a dead field only a fork can
  populate), and is no less auditable than any other project-metadata mutation.
- **`addMember` rejects a re-add** — rejected in favor of upsert (see Decision).
```
