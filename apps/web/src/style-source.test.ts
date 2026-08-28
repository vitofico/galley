import { describe, it, expect, beforeEach } from "vitest";
import { BUILT_IN_STYLES } from "./styles-library/index.js";
import {
  checkDescriptor,
  descriptorToStyle,
  namespacedId,
  materializeDescriptors,
  collectFromSources,
  registerStyleSource,
  unregisterStyleSource,
  listStyleSources,
  __resetStyleSourcesForTests,
  MAX_SOURCE_BYTES,
  MAX_DESCRIPTORS_PER_SOURCE,
  SOURCE_ID_PREFIX,
  type StyleDescriptor,
  type StyleSource,
} from "./style-source.js";

/**
 * style-source (styles Phase 2 — async catalog seam) tests. Node-env, no jsdom
 * (the repo house pattern). We test the PURE engine end to end: descriptor
 * validation of hostile remote data, materialisation + namespacing, the module
 * registry lifecycle, and the async `collectFromSources` fold (allSettled
 * isolation + the zero-sources-zero-work guarantee). The hook `useStyleSources`
 * is a thin shell over `collectFromSources`; its React lifecycle is covered by
 * the mounting lane's e2e.
 */

// A control-char string built without typing any literal control byte.
const CTRL = String.fromCharCode(0, 9, 0x1f, 0x7f);

/** A minimal well-formed descriptor. */
function ok(over: Partial<StyleDescriptor> = {}): StyleDescriptor {
  return { id: "s1", name: "Style One", source: "#let doc(body) = body\n", ...over };
}

describe("checkDescriptor — hostile / untrusted input", () => {
  it("strips control chars from the name (keeps the descriptor)", () => {
    const r = checkDescriptor(ok({ name: `Evil${CTRL}Name` }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.descriptor.name).toBe("EvilName");
  });

  it("strips control chars from id/description too", () => {
    const r = checkDescriptor(ok({ id: `a${CTRL}b`, description: `desc${CTRL}line` }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.descriptor.id).toBe("ab");
      expect(r.descriptor.description).toBe("descline");
    }
  });

  it("drops a descriptor whose name is only control chars (empty after clean)", () => {
    const r = checkDescriptor(ok({ name: CTRL }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/name/i);
  });

  it("drops a descriptor with an empty/whitespace id", () => {
    expect(checkDescriptor(ok({ id: "   " })).ok).toBe(false);
    expect(checkDescriptor(ok({ id: "" })).ok).toBe(false);
  });

  it("drops a descriptor with no source text", () => {
    const r = checkDescriptor({ id: "x", name: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/source/i);
  });

  it("drops a descriptor whose source exceeds the byte cap", () => {
    const r = checkDescriptor(ok({ source: "x".repeat(MAX_SOURCE_BYTES + 1) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exceeds/i);
  });

  it("keeps a source exactly at the byte cap", () => {
    expect(checkDescriptor(ok({ source: "x".repeat(MAX_SOURCE_BYTES) })).ok).toBe(true);
  });

  it("drops non-object descriptors without throwing", () => {
    for (const bad of [null, undefined, 42, "str", []]) {
      expect(checkDescriptor(bad).ok).toBe(false);
    }
  });

  it("filters invalid capability ids, keeping only valid Typst symbol names", () => {
    const r = checkDescriptor(
      ok({ capabilities: ["fig", "bad id", "has*star", "1leading", "", "theorem", "fig"] }),
    );
    expect(r.ok).toBe(true);
    // valid ids only, deduped + sorted:
    if (r.ok) expect(r.descriptor.capabilities).toEqual(["fig", "theorem"]);
  });

  it("treats a present-but-malformed capabilities field as claiming nothing", () => {
    const r = checkDescriptor(ok({ capabilities: "fig" as unknown as string[] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.descriptor.capabilities).toEqual([]);
  });

  it("keeps capabilities ABSENT when the field is omitted (so it can be derived)", () => {
    const r = checkDescriptor(ok());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.descriptor.capabilities).toBeUndefined();
  });

  it("cleans + caps tags, dropping empties", () => {
    const r = checkDescriptor(ok({ tags: ["  math  ", `bad${CTRL}tag`, "", "math"] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.descriptor.tags).toEqual(["math", "badtag"]);
  });
});

describe("descriptorToStyle — materialisation", () => {
  it("derives capabilities from the source when the descriptor omits them", () => {
    const d = ok({ source: "#let doc(body) = body\n#let fig(x) = x\n" });
    const style = descriptorToStyle(d, "cloud");
    // `doc` + palette tokens excluded; `fig` is the provided helper.
    expect(style.manifest.capabilities).toEqual(["fig"]);
  });

  it("uses the descriptor's declared capabilities over derivation when present", () => {
    const d = ok({ source: "#let doc(body) = body\n#let fig(x) = x\n", capabilities: ["theorem"] });
    const style = descriptorToStyle(d, "cloud");
    expect(style.manifest.capabilities).toEqual(["theorem"]);
  });

  it("materialises a non-builtin canonical-ABI style with the source as /style.typ", () => {
    const style = descriptorToStyle(ok(), "cloud");
    expect(style.manifest.builtin).toBe(false);
    expect(style.manifest.entry).toBe("doc");
    expect(style.manifest.abiVersion).toBe(1);
    expect(style.entryFile).toBe("/style.typ");
    expect(style.files).toEqual([{ path: "/style.typ", text: "#let doc(body) = body\n" }]);
  });

  it("carries a sanitized description onto the manifest, omitting it when absent", () => {
    expect(descriptorToStyle(ok({ description: "A hosted style" }), "cloud").manifest.description).toBe(
      "A hosted style",
    );
    expect(descriptorToStyle(ok(), "cloud").manifest.description).toBeUndefined();
  });
});

describe("namespacing — no collision with built-in or local ids", () => {
  it("prefixes the manifest id with source:<sourceId>:", () => {
    expect(namespacedId("cloud", "mystyle")).toBe("source:cloud:mystyle");
    expect(descriptorToStyle(ok({ id: "mystyle" }), "cloud").manifest.id).toBe("source:cloud:mystyle");
  });

  it("cannot collide with a bundled id (bare slug) or a saved local id (local-…)", () => {
    const builtinIds = new Set(BUILT_IN_STYLES.map((s) => s.manifest.id));
    for (const b of BUILT_IN_STYLES) {
      const id = namespacedId("cloud", b.manifest.id);
      expect(builtinIds.has(id)).toBe(false);
      expect(id.startsWith("local-")).toBe(false);
      expect(id.startsWith(`${SOURCE_ID_PREFIX}:`)).toBe(true);
    }
  });

  it("distinct sources produce distinct ids for the same descriptor id", () => {
    expect(namespacedId("s1", "x")).not.toBe(namespacedId("s2", "x"));
  });
});

describe("materializeDescriptors — validation + dedup at the source level", () => {
  it("materialises the valid descriptors and records a drop per invalid one", () => {
    const { styles, drops } = materializeDescriptors("cloud", [
      ok({ id: "a", name: "A" }),
      { id: "", name: "no id", source: "x" }, // dropped
      ok({ id: "b", name: "B" }),
    ]);
    expect(styles.map((s) => s.manifest.id)).toEqual(["source:cloud:a", "source:cloud:b"]);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.sourceId).toBe("cloud");
  });

  it("dedupes by materialised id (first wins) within a source", () => {
    const { styles, drops } = materializeDescriptors("cloud", [
      ok({ id: "dup", name: "First" }),
      ok({ id: "dup", name: "Second" }),
    ]);
    expect(styles).toHaveLength(1);
    expect(styles[0]!.manifest.name).toBe("First");
    expect(drops.some((d) => /duplicate/i.test(d.message))).toBe(true);
  });

  it("returns an error (no styles) when list() did not return an array", () => {
    const { styles, drops } = materializeDescriptors("cloud", "not-an-array");
    expect(styles).toEqual([]);
    expect(drops).toEqual([{ sourceId: "cloud", message: "source did not return a list" }]);
  });

  it("caps the number of descriptors processed from one source", () => {
    const many = Array.from({ length: MAX_DESCRIPTORS_PER_SOURCE + 5 }, (_, i) =>
      ok({ id: `id${i}`, name: `N${i}` }),
    );
    const { styles, drops } = materializeDescriptors("cloud", many);
    expect(styles).toHaveLength(MAX_DESCRIPTORS_PER_SOURCE);
    expect(drops.some((d) => /truncated/i.test(d.message))).toBe(true);
  });
});

describe("registry lifecycle", () => {
  beforeEach(() => __resetStyleSourcesForTests());

  const src = (id: string): StyleSource => ({ id, label: id, list: async () => [] });

  it("is EMPTY by default", () => {
    expect(listStyleSources()).toEqual([]);
  });

  it("registers, lists (in order), and unregisters sources", () => {
    registerStyleSource(src("a"));
    registerStyleSource(src("b"));
    expect(listStyleSources().map((s) => s.id)).toEqual(["a", "b"]);
    unregisterStyleSource("a");
    expect(listStyleSources().map((s) => s.id)).toEqual(["b"]);
  });

  it("replaces a source registered under the same id", () => {
    registerStyleSource(src("a"));
    const replacement = { ...src("a"), label: "replaced" };
    registerStyleSource(replacement);
    expect(listStyleSources()).toHaveLength(1);
    expect(listStyleSources()[0]!.label).toBe("replaced");
  });
});

describe("collectFromSources — async fold", () => {
  beforeEach(() => __resetStyleSourcesForTests());

  it("does ZERO async work and resolves immediately-empty with no sources", async () => {
    let listed = false;
    const spy: StyleSource = {
      id: "spy",
      label: "spy",
      list: async () => {
        listed = true;
        return [];
      },
    };
    // Not registered → not passed → never listed (the byte-for-byte guarantee).
    const result = await collectFromSources([]);
    expect(result).toEqual({ remoteStyles: [], errors: [] });
    expect(listed).toBe(false);
    void spy;
  });

  it("isolates a rejecting source — a sibling source still contributes its styles", async () => {
    const good: StyleSource = { id: "good", label: "good", list: async () => [ok({ id: "g", name: "G" })] };
    const bad: StyleSource = {
      id: "bad",
      label: "bad",
      list: async () => {
        throw new Error("boom");
      },
    };
    const { remoteStyles, errors } = await collectFromSources([good, bad]);
    expect(remoteStyles.map((s) => s.manifest.id)).toEqual(["source:good:g"]);
    expect(errors).toEqual([{ sourceId: "bad", message: "boom" }]);
  });

  it("isolates a source that throws synchronously in list()", async () => {
    const boom: StyleSource = {
      id: "boom",
      label: "boom",
      list: (() => {
        throw new Error("sync-throw");
      }) as StyleSource["list"],
    };
    const good: StyleSource = { id: "good", label: "good", list: async () => [ok({ id: "g", name: "G" })] };
    const { remoteStyles, errors } = await collectFromSources([boom, good]);
    expect(remoteStyles).toHaveLength(1);
    expect(errors).toEqual([{ sourceId: "boom", message: "sync-throw" }]);
  });

  it("records an error for a source that resolves a non-array, hiding no other", async () => {
    const junk: StyleSource = { id: "junk", label: "junk", list: async () => "nope" as unknown as StyleDescriptor[] };
    const good: StyleSource = { id: "good", label: "good", list: async () => [ok({ id: "g", name: "G" })] };
    const { remoteStyles, errors } = await collectFromSources([junk, good]);
    expect(remoteStyles).toHaveLength(1);
    expect(errors).toEqual([{ sourceId: "junk", message: "source did not return a list" }]);
  });
});
