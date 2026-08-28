/**
 * The shared commit-message format (roadmap #11/#12), lifted out of the Node-only
 * `git-version-store` so the BROWSER's GitHub push path can stamp the SAME trailer
 * block. `git-version-store.test.ts` remains the behavioral regression net for the
 * local git path; these tests pin the encoder's own contract — most importantly
 * that a hostile display label cannot FORGE a trailer, because this encoder now
 * also receives peer/CRDT-derived names (untrusted input).
 */
import { describe, it, expect } from "vitest";
import {
  encodeMessage,
  decodeMessage,
  sanitizeTrailer,
  coauthorEmail,
  CONTRIBUTOR_TRAILER,
  COAUTHOR_TRAILER,
  MAX_CONTRIBUTORS,
} from "./version-message.js";

/** Lines of `msg` that read as a trailer of `key` (i.e. START the line). */
const trailerLines = (msg: string, key: string) =>
  msg.split("\n").filter((l) => l.startsWith(`${key}: `));

describe("version-message trailer keys", () => {
  it("uses the git-conventional keys the local path already writes", () => {
    expect(CONTRIBUTOR_TRAILER).toBe("Galley-Contributor");
    expect(COAUTHOR_TRAILER).toBe("Co-authored-by");
  });
});

describe("encodeMessage", () => {
  it("is the bare subject when nothing but a name is given (no trailer block)", () => {
    expect(encodeMessage({ name: "v1" })).toBe("v1");
  });

  it("appends the body as a second paragraph", () => {
    expect(encodeMessage({ name: "v1", message: "why" })).toBe("v1\n\nwhy");
  });

  it("appends one Galley-Contributor line per contributor, plus co-author lines", () => {
    const msg = encodeMessage({
      name: "v1",
      author: { name: "Alice", email: "alice@users.galley.local" },
      contributors: ["Alice", "Bob Smith"],
    });
    expect(trailerLines(msg, CONTRIBUTOR_TRAILER)).toEqual([
      "Galley-Contributor: Alice",
      "Galley-Contributor: Bob Smith",
    ]);
    // Alice is the primary author → never self-co-authored.
    expect(trailerLines(msg, COAUTHOR_TRAILER)).toEqual([
      "Co-authored-by: Bob Smith <bob-smith@users.galley.local>",
    ]);
  });

  it("drops empty contributor labels", () => {
    const msg = encodeMessage({ name: "v1", contributors: ["", "Bob"] });
    expect(trailerLines(msg, CONTRIBUTOR_TRAILER)).toEqual(["Galley-Contributor: Bob"]);
  });

  it("round-trips through decodeMessage (contributors are read from #11 lines only)", () => {
    const input = {
      name: "v1",
      message: "body\nwith lines",
      author: { name: "Alice", email: "alice@users.galley.local" },
      contributors: ["Alice", "Bob"],
    };
    const got = decodeMessage(encodeMessage(input));
    expect(got.name).toBe("v1");
    expect(got.message).toBe("body\nwith lines");
    expect(got.contributors).toEqual(["Alice", "Bob"]);
  });
});

describe("sanitizeTrailer", () => {
  it("collapses CR/LF to a space and trims", () => {
    expect(sanitizeTrailer("Eve\r\nInjected")).toBe("Eve Injected");
    expect(sanitizeTrailer("  padded  ")).toBe("padded");
  });

  it("strips angle brackets, so a label can never carry an address", () => {
    expect(sanitizeTrailer("Bob <victim@realcompany.com>")).toBe("Bob victim@realcompany.com");
  });
});

describe("coauthorEmail", () => {
  it("slugifies a display label under the synthesized noreply domain", () => {
    expect(coauthorEmail("Bob Smith")).toBe("bob-smith@users.galley.local");
    expect(coauthorEmail("Carol Q.")).toBe("carol-q@users.galley.local");
  });

  it("falls back to `unknown` for a label with no alphanumerics", () => {
    expect(coauthorEmail("!!!")).toBe("unknown@users.galley.local");
  });
});

// --- Trailer injection (the encoder now takes untrusted peer display names) ----

describe("encodeMessage trailer injection", () => {
  it("cannot inject a SECOND address into Co-authored-by via angle brackets in a label", () => {
    // The attack: Mallory joins a shared room and names herself with an address.
    // Emitted UNFIXED, the line carried TWO `<…>` groups —
    //   Co-authored-by: Bob <victim@realcompany.com> <bob-…@users.galley.local>
    // — and which one is credited is PARSER-DEPENDENT: greedy reads ours, lazy
    // reads the attacker's. We do not control GitHub's parser, so the property
    // must be that only ONE address is present at all.
    const msg = encodeMessage({
      name: "v1",
      author: { name: "Alice", email: "alice@users.galley.local" },
      contributors: ["Bob <victim@realcompany.com>"],
    });
    const line = trailerLines(msg, COAUTHOR_TRAILER)[0] as string;

    const addresses = line.match(/<[^>]*>/g) ?? [];
    expect(addresses).toHaveLength(1); // THE invariant — one address, unambiguous
    expect(addresses[0]).toBe("<bob-victim-realcompany-com@users.galley.local>");
    // The attacker's address can no longer be READ as an address by any parser…
    expect(line).not.toContain("<victim@realcompany.com>");
    // …because greedy and lazy matchers now agree on the same (synthesized) one.
    const rest = line.slice(`${COAUTHOR_TRAILER}: `.length);
    expect(rest.match(/^(.+) <(.+)>$/)![2]).toBe(rest.match(/^(.+?) <(.+?)>/)![2]);
  });

  it("strips brackets on the #11 contributor line too (local history can't be spoofed)", () => {
    const msg = encodeMessage({ name: "v1", contributors: ["Bob <ceo@company.com>"] });
    // Galley's own HistoryPanel renders this line, so the identity-shaped
    // `Name <email>` form must not survive there either.
    expect(decodeMessage(msg).contributors).toEqual(["Bob ceo@company.com"]);
  });

  it("cannot be made to FORGE an extra trailer line via CR/LF in a contributor label", () => {
    const hostile = "Eve\nCo-authored-by: Attacker <attacker@evil.example>";
    const msg = encodeMessage({
      name: "Galley snapshot — 2026-07-15T00:00:00.000Z",
      author: { name: "Alice", email: "alice@users.galley.local" },
      contributors: [hostile],
    });
    // The payload is folded onto ONE line: exactly one trailer of each kind.
    expect(trailerLines(msg, CONTRIBUTOR_TRAILER)).toHaveLength(1);
    expect(trailerLines(msg, COAUTHOR_TRAILER)).toHaveLength(1);
    // The forged trailer never stands alone at a line start.
    expect(msg.split("\n")).not.toContain("Co-authored-by: Attacker <attacker@evil.example>");
    // Every co-author address is the SYNTHESIZED one — an attacker-chosen email
    // can never be the address git/GitHub reads (it closes the line).
    for (const l of trailerLines(msg, COAUTHOR_TRAILER)) {
      expect(l.endsWith("@users.galley.local>")).toBe(true);
    }
  });

  it("cannot forge a Galley-Contributor line that decode would read back as a person", () => {
    const hostile = "Eve\r\nGalley-Contributor: Ghost";
    const msg = encodeMessage({ name: "v1", contributors: [hostile] });
    // One contributor in, ONE contributor out — "Ghost" never becomes its own entry.
    expect(decodeMessage(msg).contributors).toEqual([
      "Eve Galley-Contributor: Ghost",
    ]);
  });

  it("cannot forge a trailer block via CR/LF in the SUBJECT (the version name)", () => {
    // A version NAMED with an embedded blank line opens a second paragraph that
    // decodeMessage would read as a trailer block — smuggling a contributor that
    // was never passed. The subject is untrusted too, so CR/LF is folded.
    const hostile = "v1\n\nGalley-Contributor: Ghost";
    const msg = encodeMessage({ name: hostile });
    // No contributors were passed → decode must read NONE; "Ghost" cannot ride
    // in on the subject.
    expect(decodeMessage(msg).contributors).toBeUndefined();
    // The folded subject round-trips as a single-line name.
    expect(decodeMessage(msg).name).toBe("v1 Galley-Contributor: Ghost");
  });

  it("bounds the contributor list at MAX_CONTRIBUTORS, however large the peer set", () => {
    // An unbounded peer swarm must not be able to inflate the trailer block.
    const many = Array.from({ length: 100 }, (_, i) => `Contributor ${i}`);
    const msg = encodeMessage({ name: "v1", contributors: many });
    const lines = trailerLines(msg, CONTRIBUTOR_TRAILER);
    expect(lines).toHaveLength(MAX_CONTRIBUTORS);
    // The kept entries are the FIRST MAX_CONTRIBUTORS, in order — a stable prefix.
    expect(lines).toEqual(
      many.slice(0, MAX_CONTRIBUTORS).map((c) => `${CONTRIBUTOR_TRAILER}: ${c}`),
    );
  });

  it("suppresses the anon self-co-author only when author and contributor labels agree", () => {
    // POST-swap: the save path stamps the SAME anonymous label the contributor
    // list carries → the solo editor is the primary author, never self-co-authored.
    const aligned = encodeMessage({
      name: "v1",
      author: { name: "Editor", email: "u@users.galley.local" },
      contributors: ["Editor"],
    });
    expect(trailerLines(aligned, COAUTHOR_TRAILER)).toEqual([]);
    // PRE-swap: ProjectApp stamps "Galley user" while the contributor label is the
    // anonymous "Editor" (authorLabel's value) — the two diverge, the equality
    // self-check misses, and the lone editor co-authors THEMSELVES. This is the
    // exact mismatch ANON_AUTHOR_LABEL exists to close once ProjectApp adopts it.
    const mismatched = encodeMessage({
      name: "v1",
      author: { name: "Galley user", email: "u@users.galley.local" },
      contributors: ["Editor"],
    });
    expect(trailerLines(mismatched, COAUTHOR_TRAILER)).toEqual([
      "Co-authored-by: Editor <editor@users.galley.local>",
    ]);
  });

  it("keeps every emitted trailer on a single line, whatever the label contains", () => {
    const msg = encodeMessage({
      name: "v1",
      author: { name: "A\nB", email: "a@x" },
      contributors: ["Mal\r\nlory", "x\n\ny"],
    });
    const block = msg.split("\n\n").at(-1) as string;
    for (const line of block.split("\n")) {
      expect(line.startsWith(`${CONTRIBUTOR_TRAILER}: `) || line.startsWith(`${COAUTHOR_TRAILER}: `)).toBe(true);
    }
  });

  it("still suppresses the self-co-author when the author name needs sanitizing", () => {
    // The comparison happens on the SANITIZED name — a CR/LF'd author must not
    // slip past the self-check and co-author themselves.
    const msg = encodeMessage({
      name: "v1",
      author: { name: "Alice\nSmith", email: "alice@users.galley.local" },
      contributors: ["Alice Smith"],
    });
    expect(trailerLines(msg, COAUTHOR_TRAILER)).toEqual([]);
  });
});
