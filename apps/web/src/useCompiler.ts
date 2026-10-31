/**
 * The compile/preview loop: owns the worker-backed compiler, debounces source
 * changes into `render` calls, cancels stale jobs, and exposes diagnostics +
 * PDF export. Live document state stays in the component (this hook is given the
 * source); the compiler never owns it.
 *
 * Enabler E2 (server-compile made reachable): the hook OPTIONALLY accepts a
 * compile `mode` ("local" | "server" | "auto"). The additions are ADDITIVE and
 * backward-compatible — `useCompiler(input)` with no options is byte-for-byte the
 * historical local-worker behaviour (plus the legacy `?serverCompile=1` flag,
 * unchanged). When a mode is supplied:
 *   - "server" builds the RemoteCompilerClient (fail-closed to worker if no URL),
 *   - "auto" runs the worker first and, on a local failure, falls back to the
 *     server compiler ONCE and VISIBLY (never silent) via the returned status
 *     fields, which the toggle/shell can surface.
 *
 * SCOPE (E2 review C4): the `mode` here governs the PREVIEW compiler ONLY. The
 * agent loop (useAgent) and the figure generator (FigurePanel) deliberately keep
 * using the local worker in this wave — mode is NOT threaded into them. The
 * toggle's honest "applies to preview" labelling is Lane S's job.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CompileCancelledError } from "@galley/compiler";
import type { Compiler } from "@galley/compiler";
import type {
  CompileInput,
  Diagnostic,
  PreviewSourceMap,
  RenderResult,
} from "@galley/shared";
import {
  createServerCompiler,
  initCompiler,
  readServerUrlInputs,
} from "./compiler-assets.js";
import { compileInputImportsPackages } from "./components/compile-input-packages.js";
import { selectRenderRoute } from "./useCompiler-routing.js";
import {
  type CompileMode,
  type FallbackState,
  createFallbackState,
  markFallbackActive,
  resolveTransport,
  shouldFallback,
} from "./components/compiler-mode.js";

const DEBOUNCE_MS = 250;
/**
 * H1: how long a recompile must stay in flight before the chip shows the `◌`
 * busy cue. Warm compiles resolve well under this, so a normal edit never flips
 * the cue — only a cold/large compile surfaces it.
 *
 * 400ms, NOT the finding's first-pass ~150ms: the operator-requested compile-speed
 * bench (STATUS `6aa4224`) measured warm edits at 5–31ms but cold/cached reflows of
 * large docs at ~175–272ms, with only the cold-first compile of a book-scale doc
 * perceptible (~0.7s). A 150ms gate would FLICKER the cue on those 175–272ms
 * reflows; 400ms (the bench's own recommendation) keeps every sub-second compile
 * calm and surfaces the cue only when a compile is genuinely, visibly slow.
 */
const BUSY_THRESHOLD_MS = 400;

// The BlobStore cache supplies immutable byte arrays and reuses each array until
// its content changes. Weak keys preserve that identity without retaining assets.
const binaryIds = new WeakMap<Uint8Array, number>();
let nextBinaryId = 0;

/** Stable compile key without serializing potentially multi-megabyte assets. */
export function compileInputKey(input: CompileInput): string {
  if (typeof input === "string") return input;
  const text = JSON.stringify({ main: input.main, files: input.files });
  const bin = (input.binaryFiles ?? []).map((b) => {
    let id = binaryIds.get(b.bytes);
    if (id === undefined) {
      id = ++nextBinaryId;
      binaryIds.set(b.bytes, id);
    }
    return [b.path, id];
  });
  return bin.length > 0 ? `${text}\u0000${JSON.stringify(bin)}` : text;
}

/** Optional behaviour knobs. Omitting them keeps the historical default path. */
export interface UseCompilerOptions {
  /** Compile mode. Omit (or "local") for the unchanged local-worker path. */
  mode?: CompileMode;
}

export interface UseCompiler {
  ready: boolean;
  /** True only when the displayed SVG was successfully rendered for this input. */
  renderFresh: boolean;
  /**
   * H1: a recompile is in flight AND has outlasted {@link BUSY_THRESHOLD_MS}, so
   * the visible preview is stale. The shell surfaces this as the `◌` chip cue.
   * Warm sub-threshold compiles never flip it, so a normal edit stays calm.
   */
  busy: boolean;
  svg: string | null;
  diagnostics: Diagnostic[];
  pageCount: number | null;
  /**
   * Forward source→preview index (#11.3), when the engine produced one. PRESENT
   * when the render path forwarded `{ sourceMap: true }` to the engine (the
   * local-worker route does) AND it could build the index; otherwise `null`
   * (e.g. the remote/package routes, which don't request a map). The shell
   * passes it to `<Preview>`, which scrolls + highlights the active region.
   */
  sourceMap: PreviewSourceMap | null;
  exportPdf: () => Promise<void>;
  /**
   * Compile + return the current document's PDF BYTES (A1 export channel) without
   * the DOM download — the same package-aware routing as {@link exportPdf}. Null
   * when no compiler is ready or the export is blocked (packages, no trusted
   * server); throws on a genuine export failure. The `export_compiled` MCP
   * responder handler calls this to obtain the bytes it pushes over the blob
   * channel.
   */
  exportPdfBytes: () => Promise<Uint8Array | null>;
  /**
   * Whether the compiler is currently a SERVER (remote) compiler — either the
   * chosen "server" mode or an "auto" fallback that engaged. The toggle/shell
   * shows an indicator when true. False on the default local path.
   */
  serverActive: boolean;
  /** True once the one-shot auto fallback to the server compiler has fired. */
  fallbackActive: boolean;
  /** Visible reason the fallback engaged (null until/unless it does). */
  fallbackReason: string | null;
  /**
   * True when `server` mode was selected but no trusted compile URL is
   * configured, so compilation silently stayed local. Lets the shell/toggle show
   * "Server unavailable — using local" instead of a misleading "Server" badge
   * (E2 review C2). False on the local/auto paths and whenever the server is up.
   */
  serverUnavailable: boolean;
  /** Generic, classified reason the server was unavailable (null when not). */
  serverUnavailableReason: string | null;
  /**
   * Package routing (Lane A, #2/E2): true when the CURRENT document imports
   * `@preview/…` packages AND the active routing sent that compile to the server
   * (auto + a trusted compile URL). The shell shows an HONEST egress badge — the
   * document is being sent to the configured compile service. False otherwise.
   */
  packagesOnServer: boolean;
  /** Generic, classified reason packages routed to the server (null when not). */
  packagesOnServerReason: string | null;
  /**
   * Fail-closed package state (Lane A, #2/E2): true when the document imports
   * `@preview/…` packages but NO trusted server is configured to resolve them, so
   * the document CANNOT be compiled here. We do NOT attempt a doomed local
   * compile; the shell renders a blocked-compile notice instead. False otherwise.
   */
  packagesUnavailable: boolean;
  /** Generic, classified reason the packages can't be compiled (null when not). */
  packagesUnavailableReason: string | null;
}

export function useCompiler(
  input: CompileInput,
  options?: UseCompilerOptions,
): UseCompiler {
  // Distinguish "caller passed no mode" (the untouched shells today → byte-for-
  // byte default path, legacy `?serverCompile=1` honoured) from "caller chose
  // local explicitly" (the new toggle). Only the former takes the legacy path.
  const modeProvided = options?.mode !== undefined;
  const mode: CompileMode = options?.mode ?? "local";
  const compilerRef = useRef<Compiler | null>(null);
  const mountedRef = useRef(true);
  const fallbackRef = useRef<FallbackState>(createFallbackState());
  const [ready, setReady] = useState(false);
  // H1: the busy cue + its threshold timer. The timer fires ~150ms into a
  // recompile and flips `busy` true only if the compile is still running, so a
  // warm edit (resolving sooner) never shows the cue.
  const [busy, setBusy] = useState(false);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [sourceMap, setSourceMap] = useState<PreviewSourceMap | null>(null);
  const [serverActive, setServerActive] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const [serverUnavailableReason, setServerUnavailableReason] = useState<
    string | null
  >(null);
  // Package routing (Lane A): per-compile state, recomputed each render from the
  // CURRENT input. The honest server-egress badge and the fail-closed blocked
  // notice live here so the shells can render them near the compile status.
  const [packagesOnServer, setPackagesOnServer] = useState(false);
  const [packagesOnServerReason, setPackagesOnServerReason] = useState<
    string | null
  >(null);
  const [packagesUnavailable, setPackagesUnavailable] = useState(false);
  const [packagesUnavailableReason, setPackagesUnavailableReason] = useState<
    string | null
  >(null);
  // A lazily-built REMOTE (server) compiler used ONLY to resolve `@preview/…`
  // packages when the package-aware router says this compile must go to the
  // server (auto + a trusted URL). It is separate from `compilerRef` (the
  // mode-chosen preview compiler) so package routing never disturbs the default
  // local-worker path. Built on demand from the SAME trusted URL inputs — no new
  // egress source. Disposed on mode change and unmount.
  const packageRemoteRef = useRef<Compiler | null>(null);
  // Monotonic compile run-id (H2). Captured per compile; a render result whose id
  // is stale (a newer compile, a mode change, or unmount has happened) is DROPPED
  // before any setState, so a slow package-remote (or worker) response can never
  // write preview/diagnostics over a newer state. Bumped on every supersede.
  const runIdRef = useRef(0);

  /** Tear down the lazily-built package-routing remote compiler, if any. */
  function disposePackageRemote(): void {
    packageRemoteRef.current?.dispose();
    packageRemoteRef.current = null;
  }

  // A stable change key: a project input is a fresh object every render, so we
  // depend on its serialization (not its identity) to avoid recompiling forever.
  // `compileInputKey` keeps binary bytes OUT of the key (see its doc). M13: memo
  // it on `input` identity — when the shell hands us a STABLE input (memoized on
  // the doc revision, so a cursor move reuses it) the full-text serialization no
  // longer re-runs every render. The key VALUE is identical either way, so the
  // compile effect fires exactly when it did before — this only skips redundant work.
  const inputKey = useMemo(() => compileInputKey(input), [input]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate any in-flight compile (H2) and tear down the package remote.
      runIdRef.current++;
      disposePackageRemote();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  useEffect(() => {
    let disposed = false;
    // Reset ALL visible state on a mode change so stale status from the previous
    // compiler can't linger (E2 review C3). `ready` goes false until the new
    // compiler is built; the `disposed` guard below means a stale async init from
    // a superseded mode can never write back over a newer one.
    fallbackRef.current = createFallbackState();
    setReady(false);
    setFallbackActive(false);
    setFallbackReason(null);
    // C2: clear package-routing state on a mode change and dispose any package
    // remote, so a stale "compiled on the server" / "can't compile here" badge
    // (and the egressing client behind it) can't linger into the new mode. Bump
    // the run-id so any in-flight render from the previous mode is dropped (H2).
    runIdRef.current++;
    setPackagesOnServer(false);
    setPackagesOnServerReason(null);
    setPackagesUnavailable(false);
    setPackagesUnavailableReason(null);
    disposePackageRemote();

    const inputs = readServerUrlInputs();
    // Compute the transport up front so the serverActive indicator reflects the
    // chosen transport (remote vs worker) even before the first compile. In the
    // no-mode default path, "remote" only when the legacy flag forced it.
    const resolved = modeProvided
      ? resolveTransport(mode, inputs)
      : {
          transport: inputs.serverCompileFlag ? "remote" : "worker",
          downgradeReason: null,
        };
    const initialTransport = resolved.transport;
    // C2: `server` chosen but no trusted URL → silent local downgrade. Surface it.
    setServerActive(initialTransport === "remote");
    setServerUnavailable(resolved.downgradeReason !== null);
    setServerUnavailableReason(resolved.downgradeReason);

    // No mode provided → byte-for-byte the historical zero-arg path (legacy flag
    // aware). Mode provided → route the explicit choice through initCompiler.
    const initPromise = modeProvided ? initCompiler(mode) : initCompiler();

    initPromise
      .then((compiler) => {
        if (disposed) {
          compiler.dispose();
          return;
        }
        compilerRef.current = compiler;
        setReady(true);
      })
      .catch((err) => {
        console.error("compiler init failed", err);
        // AUTO one-shot fallback on a local-worker init failure. Pass the effect's
        // `disposed` flag: a stale init rejection (the [mode] effect re-ran while
        // this init was in flight) must NOT clobber the new effect's compiler ref
        // or write stale fallback state — the new effect runs its own fallback.
        maybeFallback(
          () => {
            if (disposed) return;
            setReady(true);
          },
          () => disposed,
        );
      });
    return () => {
      disposed = true;
      compilerRef.current?.dispose();
      compilerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode is the only opt-in input
  }, [mode]);

  /**
   * Attempt the one-shot auto fallback to the server compiler. VISIBLE: sets the
   * status fields so the toggle/shell can show the downgrade. Never silent, never
   * loops. `onReady` runs when a compiler became available.
   *
   * INFO-LEAK DEFENSE (E2 review H2): the visible reason is the GENERIC
   * {@link markFallbackActive} string only — the underlying error is logged to
   * the console by the caller, never interpolated into the DOM-visible badge.
   */
  function maybeFallback(onReady: () => void, isDisposed: () => boolean): void {
    // A superseded effect (mode changed mid-init) must do nothing: bail BEFORE
    // touching the compiler ref or any state — the live effect owns fallback now.
    if (isDisposed()) return;
    const inputs = readServerUrlInputs();
    if (!shouldFallback(mode, fallbackRef.current, inputs)) return;
    const remote = createServerCompiler(inputs);
    if (!remote) return; // fail closed: no server configured
    const next = markFallbackActive();
    fallbackRef.current = next;
    const old = compilerRef.current;
    compilerRef.current = remote;
    if (old !== remote) old?.dispose();
    if (!mountedRef.current) return;
    setServerActive(true);
    setFallbackActive(true);
    setFallbackReason(next.reason);
    onReady();
  }

  useEffect(() => {
    if (!ready) return;
    const compiler = compilerRef.current;
    if (!compiler) return;

    // Package-aware routing (Lane A, #2/E2). The PURE decision lives in
    // `selectRenderRoute` (unit-tested); here we turn it into the concrete
    // compiler + visible state. Recomputed per compile from the CURRENT input and
    // the SAME trusted inputs the mode resolver uses — no new egress source. With
    // no `@preview/…` import this is byte-for-byte the historical worker path.
    const inputs = readServerUrlInputs();
    const importsPackages = compileInputImportsPackages(input);
    const route = selectRenderRoute(mode, importsPackages, inputs);

    // FAIL CLOSED: packages imported, no trusted server to resolve them → do NOT
    // attempt a doomed worker compile. Surface the generic blocked-compile notice
    // and leave the prior preview untouched; never silent egress, never a doomed
    // local compile.
    if (route.kind === "blocked") {
      compiler.cancel();
      setPackagesUnavailable(true);
      setPackagesUnavailableReason(route.reason);
      setPackagesOnServer(false);
      setPackagesOnServerReason(null);
      return;
    }
    setPackagesUnavailable(false);
    setPackagesUnavailableReason(null);

    let renderCompiler = compiler;
    if (route.kind === "packageRemote") {
      // Honest server-egress: compile on the lazily-built remote compiler (same
      // trusted URL — no new egress surface) and show the VISIBLE "compiled on the
      // server" badge. The reason names only the CATEGORY (packages), never the
      // URL/content.
      if (!packageRemoteRef.current) {
        packageRemoteRef.current = createServerCompiler(inputs);
      }
      if (packageRemoteRef.current) {
        renderCompiler = packageRemoteRef.current;
        setPackagesOnServer(true);
        setPackagesOnServerReason(route.reason);
      } else {
        // Defensive: serverConfigured() said yes but the build failed. Fail closed
        // rather than silently compile a package doc locally (which can't resolve).
        compiler.cancel();
        setPackagesUnavailable(true);
        setPackagesUnavailableReason(null);
        setPackagesOnServer(false);
        setPackagesOnServerReason(null);
        return;
      }
    } else {
      setPackagesOnServer(false);
      setPackagesOnServerReason(null);
    }

    // H1: fallback is allowed ONLY when the failing attempt was a LOCAL WORKER
    // attempt (route.mayAutoFallback). A remote/package-route failure must NOT
    // build a second remote, must NOT mutate fallbackRef/compilerRef, and must NOT
    // keep egressing under a false "Local compiler failed" badge.
    const mayAutoFallback = route.mayAutoFallback;

    // H2: capture a per-compile run-id. Any result (or fallback result) whose id
    // is stale — a newer compile, a mode change, or unmount bumped it — is dropped
    // before any setState, so a slow response cannot clobber newer state.
    const myRunId = ++runIdRef.current;
    const fresh = () => mountedRef.current && runIdRef.current === myRunId;

    // #11.3 forward sync: request the source→preview index ONLY on the worker
    // route (route.requestSourceMap; the engine builds it best-effort). The
    // remote/package route stays 1-arg — the server returns no map, so preview-sync
    // stays inert there. `render(input)` (no opts) is byte-for-byte historical.
    const renderOnce = (c: Compiler): Promise<RenderResult> =>
      route.requestSourceMap
        ? c.render(input, { sourceMap: true })
        : c.render(input);

    // H1: arm/clear the busy cue for THIS compile. Armed when the render fires;
    // flips `busy` true only if the compile outlasts the threshold; cleared on any
    // terminal outcome (resolve, cancel, no-fallback error) for a fresh run.
    const endBusy = () => {
      if (busyTimerRef.current !== undefined) {
        clearTimeout(busyTimerRef.current);
        busyTimerRef.current = undefined;
      }
      if (fresh()) setBusy(false);
    };

    const handle = setTimeout(() => {
      renderCompiler.cancel(); // supersede any in-flight preview compile
      busyTimerRef.current = setTimeout(() => {
        if (fresh()) setBusy(true);
      }, BUSY_THRESHOLD_MS);
      renderOnce(renderCompiler)
        .then((res) => {
          endBusy();
          if (!fresh()) return; // superseded / unmounted / mode-changed
          setDiagnostics(res.diagnostics);
          if (res.ok && res.pages[0]) {
            setSvg(res.pages[0].svg);
            setRenderedKey(`${mode}\0${inputKey}`);
            // The REAL page count: `pages` holds ONE combined-SVG entry for the
            // whole document, so `pages.length` would report "1 page(s)" for a
            // multi-page doc (#20.2). Fall back only when the result predates
            // the field (older remote compile services).
            setPageCount(res.pageCount ?? res.pages.length);
            // Hold the forward index when the render produced one. Absent on the
            // remote path (no map from the server) → null, so Preview's
            // highlight/scroll stays inert there and the default is unchanged.
            setSourceMap(res.sourceMap ?? null);
          }
        })
        .catch((err) => {
          if (err instanceof CompileCancelledError) {
            endBusy();
            return;
          }
          console.error("render failed", err);
          if (!mayAutoFallback) {
            endBusy(); // H1: terminal — error with no fallback, the cue must clear
            return; // H1: never fall back off a remote attempt
          }
          // AUTO one-shot fallback on a LOCAL-WORKER render failure: retry the
          // failed render once against the server compiler, visibly. The error is
          // logged above; the visible reason is generic (no error text leaks).
          // (No effect-disposal concept on the render path — pass a never-disposed
          // predicate so behavior here is unchanged; the guard is for init races.)
          maybeFallback(
            () => {
              const remote = compilerRef.current;
              if (!remote) return;
              // The fallback compiler is the remote server client → no source map.
              remote
                .render(input)
                .then((res) => {
                  if (!fresh()) return;
                  setDiagnostics(res.diagnostics);
                  if (res.ok && res.pages[0]) {
                    setSvg(res.pages[0].svg);
                    setRenderedKey(`${mode}\0${inputKey}`);
                    // Same honest count as the worker path (#20.2): the combined
                    // SVG is one `pages` entry, not the page count.
                    setPageCount(res.pageCount ?? res.pages.length);
                    setSourceMap(res.sourceMap ?? null);
                  }
                })
                .catch((e) => {
                  if (!(e instanceof CompileCancelledError))
                    console.error("server render failed", e);
                });
            },
            () => false,
          );
          // H1: clear the cue now; the rare auto-fallback render proceeds without
          // it (safe — the cue can never stick, e.g. if maybeFallback no-ops).
          endBusy();
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      // H1: a supersede/unmount ends this compile's cue. Clear the threshold timer
      // and drop busy so a stale cue can't linger into the next compile.
      if (busyTimerRef.current !== undefined) {
        clearTimeout(busyTimerRef.current);
        busyTimerRef.current = undefined;
      }
      setBusy(false);
      // H2: invalidate this compile's run-id on supersede so a late response is
      // dropped, and cancel the in-flight job on whichever compiler ran it (the
      // package remote included) so it stops producing a now-stale result.
      runIdRef.current++;
      renderCompiler.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputKey stands in for `input`
  }, [inputKey, ready]);

  /**
   * Compile + return the PDF BYTES of the current document, applying the SAME
   * package-aware routing as {@link exportPdf}'s download path (factored out of it
   * so the A1 `export_compiled` MCP responder can obtain the bytes without the DOM
   * download side effects). Returns null when no compiler is ready or the export is
   * BLOCKED (packages with no trusted server) — the caller treats null as "no
   * artifact available right now". THROWS only on a genuine export failure (the
   * compile produced no PDF, or the compiler rejected), so a caller can distinguish
   * "blocked/not-ready" (null) from "tried and failed" (throw).
   */
  const exportPdfBytes = async (): Promise<Uint8Array | null> => {
    const compiler = compilerRef.current;
    if (!compiler) return null;

    // C1: export must follow the SAME package-aware routing as the preview, or a
    // `@preview`-package document would be exported through the fail-closed worker
    // and silently produce a broken/empty PDF. Use the SAME pure route decision
    // as the preview (selectRenderRoute) over the SAME trusted inputs — no new
    // egress source.
    const inputs = readServerUrlInputs();
    const importsPackages = compileInputImportsPackages(input);
    const route = selectRenderRoute(mode, importsPackages, inputs);

    // FAIL CLOSED: packages, no trusted server → block the export and surface the
    // same blocked-compile notice the preview shows. Never emit a broken PDF.
    if (route.kind === "blocked") {
      setPackagesUnavailable(true);
      setPackagesUnavailableReason(route.reason);
      return null;
    }

    // Route the export to the package remote when the preview is (auto-mode)
    // egressing for packages; otherwise the mode-chosen compiler (server mode is
    // already remote, and the no-package worker path is correct). Reuse the
    // preview's package remote, building it on demand if export ran before the
    // first compile — same trusted inputs, same egress already disclosed by the
    // visible "compiled on the server" badge, so no new/undisclosed egress.
    let exporter = compiler;
    if (route.kind === "packageRemote") {
      if (!packageRemoteRef.current)
        packageRemoteRef.current = createServerCompiler(inputs);
      if (packageRemoteRef.current) {
        exporter = packageRemoteRef.current;
        setPackagesOnServer(true);
        setPackagesOnServerReason(route.reason);
      } else {
        // Defensive: configured-but-unbuildable → block rather than emit a broken
        // PDF through the package-blind worker.
        setPackagesUnavailable(true);
        setPackagesUnavailableReason(null);
        return null;
      }
    }
    const res = await exporter.export(input);
    // H4: an export that produces no PDF (e.g. the compile failed) is a FAILURE the
    // caller must surface — not a silent no-op. Throw so the download wrapper shows
    // the export-failure banner (and the A1 responder fails closed).
    if (!res.pdf) throw new Error("export produced no PDF");
    return res.pdf;
  };

  const exportPdf = async (): Promise<void> => {
    const pdf = await exportPdfBytes();
    // null ⇒ not ready / blocked (the blocked-compile notice was already surfaced
    // by exportPdfBytes); nothing to download. A genuine failure threw above.
    if (pdf === null) return;
    // Cast at the Blob boundary: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
    // which the DOM's BlobPart (ArrayBufferView<ArrayBuffer>) rejects. The bytes
    // are a plain ArrayBuffer at runtime.
    const blob = new Blob([pdf as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "document.pdf";
    a.click();
    // Defer the revoke: revoking synchronously right after click() can race the
    // browser's asynchronous read of the blob URL for the download, which in some
    // engines yields an empty/failed save. A later tick is safely past the read.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return {
    ready,
    renderFresh:
      ready && svg !== null && renderedKey === `${mode}\0${inputKey}`,
    busy,
    svg,
    diagnostics,
    pageCount,
    sourceMap,
    exportPdf,
    exportPdfBytes,
    serverActive,
    fallbackActive,
    fallbackReason,
    serverUnavailable,
    serverUnavailableReason,
    packagesOnServer,
    packagesOnServerReason,
    packagesUnavailable,
    packagesUnavailableReason,
  };
}
