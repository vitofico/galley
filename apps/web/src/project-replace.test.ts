import { describe, it, expect } from "vitest";
import { CollabProject, authorOrigin } from "@galley/collab";
import type { Author } from "@galley/shared";
import {
  applyReplaceChanges,
  applySpans,
  planReplacements,
  planSingleReplacement,
  replaceAllLabel,
  type ReplaceChange,
  type ReplaceDocAccess,
} from "./project-replace.js";
import { applyMinimalDiff } from "./collab-session.js";
import { searchProjectFiles, type SearchInputFile } from "./project-search.js";

/** Tiny helper to build the {fileId, path, text} input rows tersely. */
function file(fileId: string, path: string, text: string): SearchInputFile {
  return { fileId, path, text };
}

/** Caps high enough that no property/parity test ever truncates. */
const UNCAPPED = { maxMatchesPerFile: 100_000, maxFiles: 100_000 };

describe("applySpans", () => {
  it("stitches untouched segments around each replaced span", () => {
    expect(
      applySpans("hello world", [{ from: 6, to: 11 }], "there"),
    ).toBe("hello there");
  });

  it("handles multiple spans left-to-right", () => {
    // "a cat and a cat" — both "cat" spans swapped.
    expect(
      applySpans(
        "a cat and a cat",
        [
          { from: 2, to: 5 },
          { from: 12, to: 15 },
        ],
        "dog",
      ),
    ).toBe("a dog and a dog");
  });

  it("an empty replacement deletes the spans", () => {
    expect(applySpans("axbxc", [{ from: 1, to: 2 }, { from: 3, to: 4 }], "")).toBe("abc");
  });

  it("no spans returns the text unchanged (same string content)", () => {
    expect(applySpans("unchanged", [], "zzz")).toBe("unchanged");
  });
});

describe("planReplacements — basics", () => {
  it("an empty / whitespace-only query plans nothing", () => {
    const files = [file("a", "/main.typ", "hello")];
    expect(planReplacements(files, "", "x").files).toEqual([]);
    expect(planReplacements(files, "   ", "x").totalReplacements).toBe(0);
  });

  it("a query with no occurrences plans nothing", () => {
    const r = planReplacements([file("a", "/main.typ", "hello")], "zzz", "x");
    expect(r.files).toEqual([]);
    expect(r.totalReplacements).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("plans the per-file next text and counts every match", () => {
    const r = planReplacements(
      [
        file("a", "/main.typ", "the cat sat on the cat mat"),
        file("b", "/notes.typ", "no felines here"),
        file("c", "/cats.typ", "cat"),
      ],
      "cat",
      "dog",
    );
    expect(r.totalReplacements).toBe(3);
    expect(r.files).toHaveLength(2); // non-matching file omitted
    expect(r.files[0]).toMatchObject({
      fileId: "a",
      path: "/main.typ",
      prevText: "the cat sat on the cat mat",
      nextText: "the dog sat on the dog mat",
    });
    expect(r.files[0]!.spans).toEqual([
      { from: 4, to: 7 },
      { from: 19, to: 22 },
    ]);
    expect(r.files[1]).toMatchObject({ fileId: "c", nextText: "dog" });
  });

  it("matches case-insensitively but replaces with the replacement verbatim", () => {
    const r = planReplacements([file("a", "/f.typ", "Cat CAT cat")], "cat", "dog");
    expect(r.totalReplacements).toBe(3);
    expect(r.files[0]!.nextText).toBe("dog dog dog");
  });

  it("trims the query (the same semantics the search panel shows)", () => {
    const r = planReplacements([file("a", "/f.typ", "a cat b")], "  cat  ", "dog");
    expect(r.totalReplacements).toBe(1);
    expect(r.files[0]!.nextText).toBe("a dog b");
  });

  it("an empty replacement deletes every match", () => {
    const r = planReplacements([file("a", "/f.typ", "xay xby")], "x", "");
    expect(r.files[0]!.nextText).toBe("ay by");
    expect(r.totalReplacements).toBe(2);
  });

  it("a replacement CONTAINING the query is a single pass — never a rescan loop", () => {
    // "cat" → "catalog cat": the planned spans come from the ORIGINAL text, so
    // the new occurrences embedded in the replacement are not re-replaced.
    const r = planReplacements([file("a", "/f.typ", "cat cat")], "cat", "catalog cat");
    expect(r.totalReplacements).toBe(2);
    expect(r.files[0]!.nextText).toBe("catalog cat catalog cat");
  });

  it("overlapping occurrences resolve left-to-right non-overlapping", () => {
    // "aaa" with query "aa": one match at 0 (the scan resumes past it), so the
    // replace consumes [0,2) and leaves the trailing "a".
    const r = planReplacements([file("a", "/f.typ", "aaa")], "aa", "b");
    expect(r.totalReplacements).toBe(1);
    expect(r.files[0]!.nextText).toBe("ba");
  });

  it("UTF-16 offsets: astral characters before a match do not skew the spans", () => {
    const r = planReplacements([file("a", "/f.typ", "😀x match here")], "match", "hit");
    expect(r.files[0]!.nextText).toBe("😀x hit here");
  });

  it("honours the search caps and surfaces truncation (replace changes what search shows)", () => {
    const text = Array.from({ length: 5 }, () => "hit").join(" ");
    const r = planReplacements([file("a", "/f.typ", text)], "hit", "x", {
      maxMatchesPerFile: 3,
    });
    expect(r.totalReplacements).toBe(3);
    expect(r.totalMatchesAll).toBe(5); // the HONEST grand total survives the cap
    expect(r.truncated).toBe(true);
    // Only the first 3 (shown) matches change; the last 2 survive.
    expect(r.files[0]!.nextText).toBe("x x x hit hit");
  });

  it("reports totalMatchesAll === totalReplacements when nothing is capped", () => {
    const r = planReplacements([file("a", "/f.typ", "a b a")], "a", "z");
    expect(r.totalReplacements).toBe(2);
    expect(r.totalMatchesAll).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("Unicode: an expanding character ('İ') before a match never skews the replace", () => {
    // 'İ' lowercases to 2 code units — a lowercased-haystack offset would land
    // one unit right and produce "İ cdog mat". The plan must use ORIGINAL
    // offsets: "İ cat mat" → "İ dog mat".
    const r = planReplacements([file("a", "/f.typ", "İ cat mat")], "cat", "dog");
    expect(r.totalReplacements).toBe(1);
    expect(r.files[0]!.nextText).toBe("İ dog mat");
  });

  it("Unicode: span width follows the LOWERCASED query ('İ' → 2-unit matches)", () => {
    // Query 'İ' lowercases to "i̇" (2 units); the text carries that exact
    // sequence. The replaced span must cover both units — not the query's
    // original 1-unit length.
    const text = "ab i\u0307 cd";
    const r = planReplacements([file("a", "/f.typ", text)], "İ", "X");
    expect(r.totalReplacements).toBe(1);
    expect(r.files[0]!.nextText).toBe("ab X cd");
  });

  it("Unicode: ẞ/ß (length-preserving case pair) replaces at the right offsets", () => {
    const r = planReplacements([file("a", "/f.typ", "GROẞ groß")], "ß", "ss");
    expect(r.totalReplacements).toBe(2);
    expect(r.files[0]!.nextText).toBe("GROss gross");
  });
});

describe("planSingleReplacement", () => {
  const files = [file("a", "/f.typ", "the cat sat on the cat mat")];

  it("replaces exactly the one match at the given offset", () => {
    const p = planSingleReplacement(files, "a", 19, "cat", "dog");
    expect(p).not.toBeNull();
    expect(p!.nextText).toBe("the cat sat on the dog mat");
    expect(p!.spans).toEqual([{ from: 19, to: 22 }]);
  });

  it("validates the span still holds the query (case-insensitively)", () => {
    expect(planSingleReplacement([file("a", "/f.typ", "the CAT sat")], "a", 4, "cat", "dog")!.nextText).toBe(
      "the dog sat",
    );
  });

  it("returns null when the text changed under the match (stale offset)", () => {
    expect(planSingleReplacement(files, "a", 5, "cat", "dog")).toBeNull();
  });

  it("returns null for an unknown file or an empty query", () => {
    expect(planSingleReplacement(files, "nope", 4, "cat", "dog")).toBeNull();
    expect(planSingleReplacement(files, "a", 4, "  ", "dog")).toBeNull();
  });
});

// ── Property tests (hand-rolled seeded PRNG — the repo carries no fast-check) ──

/** mulberry32 — a tiny deterministic PRNG so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

function randomString(rnd: () => number, alphabet: readonly string[], len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += pick(rnd, alphabet);
  return s;
}

/** Independent oracle: count non-overlapping case-insensitive occurrences. */
function countOccurrences(text: string, query: string): number {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n++;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}

describe("planReplacements — properties (seeded)", () => {
  // Lowercase-only text+query make our case-insensitive scan coincide with
  // String#replaceAll, an independent same-semantics oracle (literal pattern,
  // left-to-right, non-overlapping, single pass). The replacement alphabet
  // EXCLUDES "$" ($-patterns are special to replaceAll, not to us).
  it("parity with String#replaceAll on case-uniform inputs", () => {
    const rnd = mulberry32(0xc0ffee);
    const textAlpha = ["a", "b", "c", " ", "\n"];
    const replAlpha = ["a", "b", "c", "x", " ", ""];
    for (let i = 0; i < 300; i++) {
      const text = randomString(rnd, textAlpha, 1 + Math.floor(rnd() * 40));
      const query = randomString(rnd, ["a", "b", "c"], 1 + Math.floor(rnd() * 3));
      const replacement = randomString(rnd, replAlpha, Math.floor(rnd() * 4));
      const plan = planReplacements([file("f", "/p.typ", text)], query, replacement, UNCAPPED);
      const next = plan.files[0]?.nextText ?? text;
      expect(next, `text=${JSON.stringify(text)} q=${JSON.stringify(query)} r=${JSON.stringify(replacement)}`).toBe(
        text.replaceAll(query, replacement),
      );
    }
  });

  it("count correctness: totalReplacements equals an independent occurrence count", () => {
    const rnd = mulberry32(0xbada55);
    const textAlpha = ["a", "B", "c", " ", "\n", "😀"];
    for (let i = 0; i < 300; i++) {
      const text = randomString(rnd, textAlpha, 1 + Math.floor(rnd() * 40));
      const query = randomString(rnd, ["a", "b", "C"], 1 + Math.floor(rnd() * 3));
      const plan = planReplacements([file("f", "/p.typ", text)], query, "Z", UNCAPPED);
      expect(plan.totalReplacements).toBe(countOccurrences(text, query));
    }
  });

  it("idempotence: with a non-empty replacement disjoint from the query, re-planning the result finds 0", () => {
    // Disjoint alphabets close BOTH reappearance routes: a query substring of
    // the replacement, and a juxtaposition across a deleted span (the
    // replacement is non-empty, so every seam contains a non-query character).
    const rnd = mulberry32(0xdecade);
    for (let i = 0; i < 300; i++) {
      const text = randomString(rnd, ["a", "b", " ", "\n"], 1 + Math.floor(rnd() * 40));
      const query = randomString(rnd, ["a", "b"], 1 + Math.floor(rnd() * 3));
      const replacement = randomString(rnd, ["x", "y", "z"], 1 + Math.floor(rnd() * 4));
      const plan = planReplacements([file("f", "/p.typ", text)], query, replacement, UNCAPPED);
      const next = plan.files[0]?.nextText ?? text;
      const replan = planReplacements([file("f", "/p.typ", next)], query, replacement, UNCAPPED);
      expect(replan.totalReplacements, `text=${JSON.stringify(text)} q=${JSON.stringify(query)}`).toBe(0);
      // ...and so does the search the panel displays (same semantics).
      expect(searchProjectFiles([file("f", "/p.typ", next)], query).totalMatches).toBe(0);
    }
  });

  it("byte-identical non-match regions: every untouched segment survives at its shifted offset", () => {
    const rnd = mulberry32(0xfeed5eed);
    for (let i = 0; i < 300; i++) {
      const text = randomString(rnd, ["a", "b", "c", " "], 1 + Math.floor(rnd() * 40));
      const query = randomString(rnd, ["a", "b"], 1 + Math.floor(rnd() * 3));
      const replacement = randomString(rnd, ["a", "b", "q", ""], Math.floor(rnd() * 4));
      const plan = planReplacements([file("f", "/p.typ", text)], query, replacement, UNCAPPED);
      if (plan.files.length === 0) continue;
      const f = plan.files[0]!;
      // Walk the spans with an explicit cumulative shift (independent of how
      // nextText was assembled) and compare every gap segment byte-for-byte.
      let delta = 0;
      let cursor = 0;
      for (const span of f.spans) {
        const gap = text.slice(cursor, span.from);
        expect(f.nextText.slice(cursor + delta, span.from + delta)).toBe(gap);
        expect(f.nextText.slice(span.from + delta, span.from + delta + replacement.length)).toBe(replacement);
        delta += replacement.length - (span.to - span.from);
        cursor = span.to;
      }
      expect(f.nextText.slice(cursor + delta)).toBe(text.slice(cursor));
    }
  });

  it("what search SHOWS is exactly what replace CHANGES (span parity under the same caps)", () => {
    const rnd = mulberry32(0x5ca1ab1e);
    for (let i = 0; i < 100; i++) {
      const text = randomString(rnd, ["a", "b", " "], 1 + Math.floor(rnd() * 60));
      const query = randomString(rnd, ["a", "b"], 1 + Math.floor(rnd() * 2));
      const shown = searchProjectFiles([file("f", "/p.typ", text)], query);
      const plan = planReplacements([file("f", "/p.typ", text)], query, "Z");
      expect(plan.totalReplacements).toBe(shown.totalMatches);
      expect(plan.files.map((f) => f.spans.map((s) => s.from))).toEqual(
        shown.files.map((g) => g.matches.map((m) => m.from)),
      );
    }
  });
});

// ── applyReplaceChanges — the ALL-OR-NOTHING transactional apply ────────────

describe("applyReplaceChanges — all-or-nothing base check (fake store)", () => {
  function fakeAccess(store: Map<string, string>): ReplaceDocAccess & { transactions: number } {
    const access = {
      transactions: 0,
      transact(fn: () => void) {
        access.transactions++;
        fn();
      },
      read: (fileId: string) => store.get(fileId),
      write: (fileId: string, nextText: string) => {
        store.set(fileId, nextText);
      },
    };
    return access;
  }

  it("applies every change in ONE transaction when all bases match", () => {
    const store = new Map([
      ["a", "the cat"],
      ["b", "a cat too"],
    ]);
    const access = fakeAccess(store);
    const ok = applyReplaceChanges(access, [
      { fileId: "a", beforeText: "the cat", nextText: "the dog" },
      { fileId: "b", beforeText: "a cat too", nextText: "a dog too" },
    ]);
    expect(ok).toBe(true);
    expect(access.transactions).toBe(1);
    expect(store.get("a")).toBe("the dog");
    expect(store.get("b")).toBe("a dog too");
  });

  it("ANY stale base aborts the WHOLE set — zero writes, false returned", () => {
    const store = new Map([
      ["a", "the cat"],
      ["b", "CONCURRENTLY EDITED"], // diverged from the plan's base
    ]);
    const ok = applyReplaceChanges(fakeAccess(store), [
      { fileId: "a", beforeText: "the cat", nextText: "the dog" },
      { fileId: "b", beforeText: "a cat too", nextText: "a dog too" },
    ]);
    expect(ok).toBe(false);
    expect(store.get("a")).toBe("the cat"); // file a was NOT half-applied
    expect(store.get("b")).toBe("CONCURRENTLY EDITED");
  });

  it("a missing (deleted) file aborts the whole set", () => {
    const store = new Map([["a", "the cat"]]);
    const ok = applyReplaceChanges(fakeAccess(store), [
      { fileId: "a", beforeText: "the cat", nextText: "the dog" },
      { fileId: "gone", beforeText: "anything", nextText: "x" },
    ]);
    expect(ok).toBe(false);
    expect(store.get("a")).toBe("the cat");
  });

  it("an empty change set is a no-op returning false", () => {
    const store = new Map([["a", "text"]]);
    const access = fakeAccess(store);
    expect(applyReplaceChanges(access, [])).toBe(false);
    expect(access.transactions).toBe(0);
  });
});

describe("applyReplaceChanges — real CRDT TOCTOU pins (CollabProject)", () => {
  const HUMAN: Author = { kind: "human", userId: "me" };
  const PEER: Author = { kind: "human", userId: "peer" };

  /** The EXACT seam ProjectApp wires: doc.transact + fileText + applyMinimalDiff. */
  function accessFor(p: CollabProject): ReplaceDocAccess {
    return {
      transact: (fn) => p.doc.transact(fn, authorOrigin(HUMAN)),
      read: (fileId) => p.fileText(fileId)?.toString(),
      write: (fileId, nextText) => {
        const text = p.fileText(fileId);
        if (text) applyMinimalDiff(text, nextText);
      },
    };
  }

  function seedTwoFiles(): { p: CollabProject; idA: string; idB: string } {
    const p = new CollabProject();
    const ids = p.seedIfPristine(
      [
        { path: "/a.typ", text: "alpha cat one" },
        { path: "/b.typ", text: "beta cat two" },
      ],
      "/a.typ",
      HUMAN,
    )!;
    return { p, idA: ids[0]!, idB: ids[1]! };
  }

  function searchRows(p: CollabProject): SearchInputFile[] {
    return p
      .snapshot()
      .files.filter((f) => !f.deleted)
      .map((f) => ({ fileId: f.fileId, path: f.path, text: f.text }));
  }

  function changesOf(plan: ReturnType<typeof planReplacements>): ReplaceChange[] {
    return plan.files.map((f) => ({
      fileId: f.fileId,
      beforeText: f.prevText,
      nextText: f.nextText,
    }));
  }

  it("CRITICAL-1 pin: a concurrent edit between plan and click aborts cleanly — nothing clobbered", () => {
    const { p, idA, idB } = seedTwoFiles();
    // The panel renders and plans against this snapshot…
    const plan = planReplacements(searchRows(p), "cat", "dog");
    expect(plan.totalReplacements).toBe(2);
    // …then a collaborator's edit lands BEFORE the click is applied.
    p.transactFile(idB, (t) => t.insert(0, "PEER WROTE THIS "), PEER);

    const ok = applyReplaceChanges(accessFor(p), changesOf(plan));
    expect(ok).toBe(false);
    // The peer's insertion is intact, and NEITHER file was touched (no
    // half-applied replace on the unchanged file either).
    expect(p.getFile(idB)!.text).toBe("PEER WROTE THIS beta cat two");
    expect(p.getFile(idA)!.text).toBe("alpha cat one");

    // Re-planning against the LIVE text then succeeds — and covers the peer's
    // text too, exactly what the "search again" notice tells the user to do.
    const replan = planReplacements(searchRows(p), "cat", "dog");
    expect(applyReplaceChanges(accessFor(p), changesOf(replan))).toBe(true);
    expect(p.getFile(idA)!.text).toBe("alpha dog one");
    expect(p.getFile(idB)!.text).toBe("PEER WROTE THIS beta dog two");
  });

  it("CRITICAL-2 pin: undo after a concurrent edit aborts — the peer's edit survives", () => {
    const { p, idA, idB } = seedTwoFiles();
    const plan = planReplacements(searchRows(p), "cat", "dog");
    expect(applyReplaceChanges(accessFor(p), changesOf(plan))).toBe(true);

    // The undo inverse the panel holds: base = post-replace, target = prior.
    const undoChanges: ReplaceChange[] = plan.files.map((f) => ({
      fileId: f.fileId,
      beforeText: f.nextText,
      nextText: f.prevText,
    }));

    // A collaborator edits ONE affected file before the undo click lands.
    p.transactFile(idA, (t) => t.insert(0, "PEER "), PEER);

    const ok = applyReplaceChanges(accessFor(p), undoChanges);
    expect(ok).toBe(false);
    // The peer's edit was NOT overwritten by the stale beforeText, and the
    // untouched file was NOT half-reverted.
    expect(p.getFile(idA)!.text).toBe("PEER alpha dog one");
    expect(p.getFile(idB)!.text).toBe("beta dog two");
  });

  it("undo with NO interleaving edit restores both files exactly (one transaction)", () => {
    const { p, idA, idB } = seedTwoFiles();
    const plan = planReplacements(searchRows(p), "cat", "dog");
    expect(applyReplaceChanges(accessFor(p), changesOf(plan))).toBe(true);
    const undoChanges: ReplaceChange[] = plan.files.map((f) => ({
      fileId: f.fileId,
      beforeText: f.nextText,
      nextText: f.prevText,
    }));
    expect(applyReplaceChanges(accessFor(p), undoChanges)).toBe(true);
    expect(p.getFile(idA)!.text).toBe("alpha cat one");
    expect(p.getFile(idB)!.text).toBe("beta cat two");
  });
});

describe("replaceAllLabel — honest truncation copy", () => {
  it("plain 'Replace all (N)' when nothing is capped", () => {
    const plan = planReplacements([file("a", "/f.typ", "x y x")], "x", "z");
    expect(replaceAllLabel(plan, "z")).toBe("Replace all (2)");
  });

  it("'Replace shown (N of M)' when the caps bite", () => {
    const text = Array.from({ length: 5 }, () => "hit").join(" ");
    const plan = planReplacements([file("a", "/f.typ", text)], "hit", "x", {
      maxMatchesPerFile: 3,
    });
    expect(replaceAllLabel(plan, "x")).toBe("Replace shown (3 of 5)");
  });

  it("appends the deletion confirmation for an empty replacement, in both modes", () => {
    const plan = planReplacements([file("a", "/f.typ", "x y x")], "x", "");
    expect(replaceAllLabel(plan, "")).toBe("Replace all (2) with ''");
    const capped = planReplacements(
      [file("a", "/f.typ", "h h h h")],
      "h",
      "",
      { maxMatchesPerFile: 2 },
    );
    expect(replaceAllLabel(capped, "")).toBe("Replace shown (2 of 4) with ''");
  });
});
