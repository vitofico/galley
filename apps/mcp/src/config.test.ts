import { describe, it, expect } from "vitest";
import {
  parseKernelConfig,
  roomFingerprint,
  KERNEL_USAGE,
  type KernelCliResult,
  type ProjectKernelConfig,
  type ControlKernelConfig,
} from "./config.js";
import { READ_LIMITS } from "./surface.js";

/** Narrow a parse result to per-project mode (fails the test otherwise). */
function asProject(result: KernelCliResult): ProjectKernelConfig {
  expect(result.mode).toBe("project");
  return result as ProjectKernelConfig;
}

/** A valid 32-byte base64url response key for control-mode parses (HIGH-1). */
const KEY_B64 = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE"; // 32 x "A"

/** Valid one-time pairing codes (B2): base64url of EXACTLY 16 bytes (~22 chars). */
const CODE16 = "AAECAwQFBgcICQoLDA0ODw"; // bytes 0..15
const CODE16B = "__79_Pv6-fj39vX08_Lx8A"; // bytes 255..240

/** Narrow a parse result to control mode (fails the test otherwise). */
function asControl(result: KernelCliResult): ControlKernelConfig {
  expect(result.mode).toBe("control");
  return result as ControlKernelConfig;
}

describe("kernel config — fail-loud CLI/env parsing", () => {
  it("parses the full flag set", () => {
    expect(
      parseKernelConfig([
        "--sync",
        "ws://localhost:1234",
        "--room",
        "share-abc",
        "--file",
        "/main.typ",
        "--compile-url",
        "http://localhost:3001",
      ]),
    ).toEqual({
      mode: "project",
      syncUrl: "ws://localhost:1234",
      room: "share-abc",
      filePath: "/main.typ",
      compileUrl: "http://localhost:3001",
    });
  });

  it("accepts --flag=value form, trims trailing slashes, canonicalizes the file path", () => {
    const cfg = asProject(
      parseKernelConfig([
        "--sync=wss://example.test:1234/",
        "--room=r1",
        "--file=main.typ",
        "--compile-url=http://localhost:3001/",
      ]),
    );
    expect(cfg.syncUrl).toBe("wss://example.test:1234");
    expect(cfg.filePath).toBe("/main.typ");
    expect(cfg.compileUrl).toBe("http://localhost:3001");
  });

  it("falls back to env vars; flags win over env", () => {
    const env = {
      GALLEY_MCP_SYNC: "ws://localhost:1234",
      GALLEY_MCP_ROOM: "env-room",
      GALLEY_MCP_FILE: "/env.typ",
      GALLEY_MCP_COMPILE_URL: "http://localhost:3001",
    };
    expect(parseKernelConfig([], env)).toEqual({
      mode: "project",
      syncUrl: "ws://localhost:1234",
      room: "env-room",
      filePath: "/env.typ",
      compileUrl: "http://localhost:3001",
    });
    const flagWins = parseKernelConfig(["--room", "flag-room"], env);
    expect(asProject(flagWins).room).toBe("flag-room");
  });

  it("compile-url is optional — omitted means not configured (never guessed)", () => {
    const cfg = asProject(
      parseKernelConfig(["--sync", "ws://h:1", "--room", "r", "--file", "/a.typ"]),
    );
    expect(cfg.compileUrl).toBeUndefined();
  });

  it.each([
    [["--room", "r", "--file", "/a.typ"], /--sync/],
    [["--sync", "ws://h:1", "--file", "/a.typ"], /--room/],
    [["--sync", "ws://h:1", "--room", "r"], /--file/],
  ])("fails loud when a required flag is missing: %j", (argv, want) => {
    expect(() => parseKernelConfig(argv)).toThrow(want);
    expect(() => parseKernelConfig(argv)).toThrow(/usage:/);
  });

  it("rejects a non-websocket --sync and a non-http --compile-url", () => {
    expect(() =>
      parseKernelConfig(["--sync", "http://h:1", "--room", "r", "--file", "/a.typ"]),
    ).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() =>
      parseKernelConfig([
        "--sync",
        "ws://h:1",
        "--room",
        "r",
        "--file",
        "/a.typ",
        "--compile-url",
        "ftp://nope",
      ]),
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it("tolerates a bare -- separator that launchers (pnpm run, claude mcp add) forward", () => {
    const cfg = asProject(
      parseKernelConfig(["--", "--sync", "ws://h:1", "--room", "r", "--file", "/a.typ"]),
    );
    expect(cfg.syncUrl).toBe("ws://h:1");
    expect(cfg.room).toBe("r");
    expect(cfg.filePath).toBe("/a.typ");
  });

  it("rejects unknown arguments and valueless flags (no silent typo tolerance)", () => {
    expect(() =>
      parseKernelConfig(["--sync", "ws://h:1", "--room", "r", "--file", "/a.typ", "--rooom", "x"]),
    ).toThrow(/unknown argument: --rooom/);
    expect(() => parseKernelConfig(["--sync"])).toThrow(/--sync requires a value/);
  });

  // --- Loopback-only compile URL (Security-Analyst finding 2) ----------------

  const base = ["--sync", "ws://localhost:1234", "--room", "r", "--file", "/a.typ"];
  const withCompile = (url: string) => [...base, "--compile-url", url];

  it.each(["http://localhost:3001", "http://127.0.0.1:3001", "http://127.5.4.3:3001", "https://[::1]:3001"])(
    "accepts the loopback compile URL %s",
    (url) => {
      expect(asProject(parseKernelConfig(withCompile(url))).compileUrl).toBe(url);
    },
  );

  it.each([
    "https://attacker.example",
    "http://192.168.1.10:3001",
    "http://compile.internal:3001",
    "http://128.0.0.1:3001",
  ])("rejects the non-loopback compile URL %s (the document is POSTed there)", (url) => {
    expect(() => parseKernelConfig(withCompile(url))).toThrow(/loopback/);
  });

  it("rejects a compile URL with embedded credentials", () => {
    expect(() => parseKernelConfig(withCompile("http://user:pass@localhost:3001"))).toThrow(
      /credentials/,
    );
  });

  it("rejects an unparsable compile URL", () => {
    expect(() => parseKernelConfig(withCompile("http://"))).toThrow(/not a valid URL/);
  });

  // --- Control mode (#16.3a, ADR-0021) ----------------------------------------

  it("parses control mode: --sync + --control-room + --response-key (+ optional --compile-url)", () => {
    const parsed = asControl(
      parseKernelConfig([
        "--sync",
        "ws://localhost:1234/",
        "--control-room",
        "ctl-abc",
        "--response-key",
        KEY_B64,
        "--compile-url",
        "http://localhost:3001",
      ]),
    );
    expect(parsed).toMatchObject({
      mode: "control",
      syncUrl: "ws://localhost:1234",
      authSource: "args",
      controlRoom: "ctl-abc",
      compileUrl: "http://localhost:3001",
    });
    expect(parsed.responseKey).toBeInstanceOf(Uint8Array);
    expect(parsed.responseKey?.length).toBe(32);
    const bare = asControl(
      parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c", "--response-key", KEY_B64]),
    );
    expect(bare.compileUrl).toBeUndefined();
  });

  // --- Control mode via --pairing-code (B2, ADR-0026) -------------------------

  it("parses B2 control mode: --sync + --pairing-code (no secret in argv)", () => {
    const parsed = asControl(
      parseKernelConfig(["--sync", "ws://localhost:1234/", "--pairing-code", CODE16]),
    );
    expect(parsed).toMatchObject({
      mode: "control",
      syncUrl: "ws://localhost:1234",
      authSource: "pairing-code",
      pairingCode: CODE16,
    });
    // The room + response key are NOT known from argv in the B2 path.
    expect(parsed.controlRoom).toBeUndefined();
    expect(parsed.responseKey).toBeUndefined();
  });

  it("B2 control mode falls back to GALLEY_MCP_PAIRING_CODE; the flag wins", () => {
    const env = { GALLEY_MCP_SYNC: "ws://h:1", GALLEY_MCP_PAIRING_CODE: CODE16 };
    expect(asControl(parseKernelConfig([], env)).pairingCode).toBe(CODE16);
    expect(asControl(parseKernelConfig(["--pairing-code", CODE16B], env)).pairingCode).toBe(CODE16B);
  });

  it("--pairing-code takes precedence over legacy --control-room/--response-key, with a loud warning (F6)", () => {
    const cfg = asControl(
      parseKernelConfig([
        "--sync",
        "ws://h:1",
        "--pairing-code",
        CODE16,
        "--control-room",
        "c",
        "--response-key",
        KEY_B64,
      ]),
    );
    // Prefer-fresh: the pairing code wins; the legacy room/key are DROPPED.
    expect(cfg.authSource).toBe("pairing-code");
    expect(cfg.pairingCode).toBe(CODE16);
    expect(cfg.controlRoom).toBeUndefined();
    expect(cfg.responseKey).toBeUndefined();
    // A loud, non-secret warning explains the dropped legacy creds.
    expect(Array.isArray(cfg.warnings)).toBe(true);
    expect(cfg.warnings!.length).toBeGreaterThan(0);
    const text = cfg.warnings!.join("\n");
    expect(text).toMatch(/precedence/i);
    expect(text).toMatch(/--control-room/);
    // The warning must NOT leak the room id or key value (capabilities).
    expect(text).not.toContain(KEY_B64);
  });

  it("--pairing-code wins over legacy creds supplied via ENV (stale shell profile), with a warning (F6)", () => {
    const cfg = asControl(
      parseKernelConfig(["--sync", "ws://h:1", "--pairing-code", CODE16], {
        GALLEY_MCP_CONTROL_ROOM: "env-ctl",
        GALLEY_MCP_RESPONSE_KEY: KEY_B64,
      }),
    );
    expect(cfg.authSource).toBe("pairing-code");
    expect(cfg.pairingCode).toBe(CODE16);
    expect(cfg.controlRoom).toBeUndefined();
    expect(cfg.responseKey).toBeUndefined();
    expect(Array.isArray(cfg.warnings)).toBe(true);
    expect(cfg.warnings!.length).toBeGreaterThan(0);
  });

  it("a clean --pairing-code (no legacy creds) carries NO warnings", () => {
    const cfg = asControl(parseKernelConfig(["--sync", "ws://h:1", "--pairing-code", CODE16]));
    // The field is OMITTED when empty, mirroring the readLimits-omitted convention.
    expect("warnings" in cfg).toBe(false);
  });

  it("a present-but-malformed --pairing-code still fails loud even when legacy creds are present (no silent legacy fall-back)", () => {
    expect(() =>
      parseKernelConfig([
        "--sync",
        "ws://h:1",
        "--pairing-code",
        "abc",
        "--control-room",
        "c",
        "--response-key",
        KEY_B64,
      ]),
    ).toThrow(/--pairing-code is malformed/);
  });

  it("--pairing-code is mutually exclusive with --room/--file", () => {
    expect(() =>
      parseKernelConfig([
        "--sync",
        "ws://h:1",
        "--pairing-code",
        CODE16,
        "--room",
        "r",
        "--file",
        "/main.typ",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a wrong-length --pairing-code (must decode to exactly 16 bytes; fails loud)", () => {
    // Too short (3 base64url chars → not 16 bytes).
    expect(() => parseKernelConfig(["--sync", "ws://h:1", "--pairing-code", "abc"])).toThrow(
      /--pairing-code is malformed/,
    );
    // Decodes, but to 12 bytes, not 16.
    expect(() =>
      parseKernelConfig(["--sync", "ws://h:1", "--pairing-code", "abcd1234efgh5678"]),
    ).toThrow(/--pairing-code is malformed/);
  });

  it("control mode falls back to GALLEY_MCP_CONTROL_ROOM / GALLEY_MCP_RESPONSE_KEY; the flag wins", () => {
    const env = {
      GALLEY_MCP_SYNC: "ws://localhost:1234",
      GALLEY_MCP_CONTROL_ROOM: "env-ctl",
      GALLEY_MCP_RESPONSE_KEY: KEY_B64,
    };
    expect(asControl(parseKernelConfig([], env)).controlRoom).toBe("env-ctl");
    expect(asControl(parseKernelConfig(["--control-room", "flag-ctl"], env)).controlRoom).toBe(
      "flag-ctl",
    );
  });

  it("control mode REQUIRES --response-key and validates it (HIGH-1; fails loud, value never echoed)", () => {
    expect(() => parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c"])).toThrow(
      /--response-key/,
    );
    expect(() =>
      parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c", "--response-key", "@@@@"]),
    ).toThrow(/base64url/);
    // Wrong length (decodes, but not to 32 bytes).
    const short = "QUFBQQ"; // 4 bytes
    let thrown: Error | undefined;
    try {
      parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c", "--response-key", short]);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/32 bytes/);
    expect(thrown?.message).not.toContain(short); // the key VALUE never echoes
  });

  it("--response-key outside control mode fails loud (never silently ignored)", () => {
    expect(() =>
      parseKernelConfig([
        "--sync",
        "ws://h:1",
        "--room",
        "r",
        "--file",
        "/a.typ",
        "--response-key",
        KEY_B64,
      ]),
    ).toThrow(/only valid in legacy control mode/);
  });

  it("--control-room is mutually exclusive with --room/--file (fails loud, never guesses)", () => {
    expect(() =>
      parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c", "--room", "r"]),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c", "--file", "/a.typ"]),
    ).toThrow(/mutually exclusive/);
    // …even when the conflicting half comes from the ENVIRONMENT.
    expect(() =>
      parseKernelConfig(["--sync", "ws://h:1", "--control-room", "c"], {
        GALLEY_MCP_ROOM: "env-room",
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("fails loud when NEITHER mode is selected, naming both options", () => {
    expect(() => parseKernelConfig(["--sync", "ws://h:1"])).toThrow(/--room \+ --file/);
    expect(() => parseKernelConfig(["--sync", "ws://h:1"])).toThrow(/--control-room/);
  });

  it("control mode still requires and validates --sync", () => {
    expect(() => parseKernelConfig(["--control-room", "c"])).toThrow(/--sync/);
    expect(() => parseKernelConfig(["--sync", "http://h:1", "--control-room", "c"])).toThrow(
      /ws:\/\/ or wss:\/\//,
    );
  });

  it("--help (anywhere) wins and the usage documents BOTH modes", () => {
    expect(parseKernelConfig(["--help"])).toEqual({ mode: "help" });
    expect(parseKernelConfig(["--sync", "ws://h:1", "--help"])).toEqual({ mode: "help" });
    expect(parseKernelConfig(["-h"])).toEqual({ mode: "help" });
    expect(KERNEL_USAGE).toMatch(/--room/);
    expect(KERNEL_USAGE).toMatch(/--control-room/);
    expect(KERNEL_USAGE).toMatch(/mutually exclusive/);
    // F6: the documented prefer-fresh precedence tracks the code.
    expect(KERNEL_USAGE).toMatch(/precedence|prefer-fresh/i);
  });

  it("roomFingerprint is non-reversible: first 4 chars + length, never the capability (Security round 2)", () => {
    const room = `share-${"0123456789abcdef".repeat(2)}`;
    const fp = roomFingerprint(room);
    expect(fp).toBe("shar…(38 chars)");
    expect(fp.includes(room)).toBe(false);
    // The fingerprint reveals at most the conventional prefix.
    expect(fp).not.toMatch(/share-[A-Za-z0-9-]{16,}/);
  });
});

describe("kernel config — tunable read caps (D2)", () => {
  const BASE = ["--sync", "ws://h:1", "--room", "r", "--file", "/main.typ"];

  it("omits readLimits entirely when no override flag is passed (defaults unchanged)", () => {
    const cfg = asProject(parseKernelConfig(BASE));
    expect("readLimits" in cfg).toBe(false);
  });

  it("parses each override flag into the readLimits field", () => {
    const cfg = asProject(
      parseKernelConfig([
        ...BASE,
        "--max-file-bytes",
        "1000",
        "--max-list-entries",
        "10",
        "--default-context-chars",
        "2048",
      ]),
    );
    expect(cfg.readLimits).toEqual({
      maxFileBytes: 1000,
      maxListEntries: 10,
      defaultContextChars: 2048,
    });
  });

  it("supports the env fallbacks (flags still win)", () => {
    const cfg = asProject(
      parseKernelConfig(BASE, { GALLEY_MCP_MAX_LIST_ENTRIES: "42" }),
    );
    expect(cfg.readLimits).toEqual({ maxListEntries: 42 });

    const flagWins = asProject(
      parseKernelConfig([...BASE, "--max-list-entries", "7"], {
        GALLEY_MCP_MAX_LIST_ENTRIES: "42",
      }),
    );
    expect(flagWins.readLimits).toEqual({ maxListEntries: 7 });
  });

  it("rejects a non-positive cap", () => {
    expect(() => parseKernelConfig([...BASE, "--max-file-bytes", "0"])).toThrow(
      /--max-file-bytes must be a positive integer/,
    );
    expect(() => parseKernelConfig([...BASE, "--max-list-entries", "-3"])).toThrow(
      /--max-list-entries must be a positive integer/,
    );
  });

  it("rejects a non-integer cap", () => {
    expect(() => parseKernelConfig([...BASE, "--max-file-bytes", "1.5"])).toThrow(
      /must be a positive integer/,
    );
    expect(() => parseKernelConfig([...BASE, "--max-list-entries", "10px"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("rejects raising a cap above its default (a read cap may only be lowered)", () => {
    expect(() =>
      parseKernelConfig([...BASE, "--max-file-bytes", String(READ_LIMITS.maxFileBytes + 1)]),
    ).toThrow(/may be lowered, never raised/);
    expect(() =>
      parseKernelConfig([...BASE, "--max-list-entries", String(READ_LIMITS.maxListEntries + 1)]),
    ).toThrow(/may be lowered, never raised/);
  });

  it("bounds --default-context-chars to [minContextChars, default] (lower-only invariant)", () => {
    // Below the per-call minimum → reject.
    expect(() =>
      parseKernelConfig([
        ...BASE,
        "--default-context-chars",
        String(READ_LIMITS.minContextChars - 1),
      ]),
    ).toThrow(/--default-context-chars must be between/);
    // ABOVE the DEFAULT (even though still <= maxContextChars) → reject: a launch
    // arg may only LOWER a cap, never raise the default budget.
    expect(READ_LIMITS.defaultContextChars).toBeLessThan(READ_LIMITS.maxContextChars);
    expect(() =>
      parseKernelConfig([
        ...BASE,
        "--default-context-chars",
        String(READ_LIMITS.defaultContextChars + 1),
      ]),
    ).toThrow(/may be lowered, never raised/);
    // The default itself is accepted (the upper bound is inclusive).
    const atDefault = asProject(
      parseKernelConfig([
        ...BASE,
        "--default-context-chars",
        String(READ_LIMITS.defaultContextChars),
      ]),
    );
    expect(atDefault.readLimits).toEqual({
      defaultContextChars: READ_LIMITS.defaultContextChars,
    });
    // A value between [min, default] is honored.
    const lowered = asProject(
      parseKernelConfig([...BASE, "--default-context-chars", String(READ_LIMITS.minContextChars)]),
    );
    expect(lowered.readLimits).toEqual({ defaultContextChars: READ_LIMITS.minContextChars });
  });

  it("carries readLimits in control mode too", () => {
    const cfg = asControl(
      parseKernelConfig([
        "--sync",
        "ws://h:1",
        "--control-room",
        "ctl",
        "--response-key",
        KEY_B64,
        "--max-list-entries",
        "5",
      ]),
    );
    expect(cfg.readLimits).toEqual({ maxListEntries: 5 });
  });
});
