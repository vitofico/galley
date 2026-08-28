import { useEffect, useRef, useState } from "react";
import { inferMime } from "@galley/collab";
import { useFocusTrap } from "./use-focus-trap.js";
import { isDisplayableRasterMime } from "../binary-upload.js";
import { formatBytes } from "../binary-files.js";
import { toPlainArrayBuffer } from "../download.js";
import "./binary-preview.css";

/**
 * `BinaryPreview` (#7 slice 7D) — a small BLOCKING modal that previews one binary
 * asset from the file tree. Opened by the asset row's label / its context menu.
 *
 * SECURITY (SEC-PAT-1 / SEC-PREVIEW-1): the stored `pointer.mime` is peer-writable
 * CRDT data and is NEVER trusted for the render decision. The bytes are RE-SNIFFED
 * with `inferMime`, and only a small raster allowlist (`isDisplayableRasterMime`)
 * is rendered via `<img>` with a Blob typed to that FORCED allowlisted literal —
 * so a forged mime can't coerce a `text/html` blob URL (which, being same-origin,
 * would be an XSS path to the plaintext PAT in localStorage). SVG renders via
 * `<img>` ONLY (its script is inert in image context) after the sniff confirms it;
 * it is never injected inline. PDF/other formats get metadata + download, no
 * inline preview. Absent/corrupt bytes → a calm "not on this device" state.
 */
export interface BinaryPreviewMeta {
  fileId: string;
  path: string;
  size: number;
  /** The pointer's DECLARED mime — shown as metadata, never used to decide rendering. */
  mime: string;
  hash: string;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "raster"; url: string }
  | { kind: "svg"; url: string }
  | { kind: "none" };

export function BinaryPreview({
  open,
  meta,
  loadBytes,
  onClose,
  onDownload,
}: {
  open: boolean;
  meta: BinaryPreviewMeta | null;
  /** Resolve a hash to its bytes (cache-first, then the BlobStore), or undefined. */
  loadBytes: (hash: string) => Promise<Uint8Array | undefined>;
  onClose: () => void;
  onDownload: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Read the loader from a ref so the resolve effect keys ONLY on open + hash
  // (the loader closure is recreated each render but is functionally stable).
  const loadBytesRef = useRef(loadBytes);
  loadBytesRef.current = loadBytes;
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Resolve the bytes and decide the render kind. Re-sniffs the mime and builds
  // the object URL from a FORCED allowlisted type; revokes it on close/change.
  useEffect(() => {
    if (!open || !meta) return;
    let cancelled = false;
    let url: string | null = null;
    setState({ kind: "loading" });
    void (async () => {
      const bytes = await loadBytesRef.current(meta.hash);
      if (cancelled) return;
      if (!bytes) {
        setState({ kind: "missing" });
        return;
      }
      const sniffed = inferMime(bytes, meta.path);
      if (isDisplayableRasterMime(sniffed)) {
        url = URL.createObjectURL(new Blob([toPlainArrayBuffer(bytes)], { type: sniffed }));
        setState({ kind: "raster", url });
      } else if (sniffed === "image/svg+xml") {
        url = URL.createObjectURL(
          new Blob([toPlainArrayBuffer(bytes)], { type: "image/svg+xml" }),
        );
        setState({ kind: "svg", url });
      } else {
        setState({ kind: "none" });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // meta identity changes each render, but its hash is the content key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meta?.hash]);

  if (!open || !meta) return null;

  const name = meta.path.slice(meta.path.lastIndexOf("/") + 1);

  return (
    <div
      className="binary-preview-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="binary-preview-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="binary-preview-title"
        data-testid="binary-preview"
      >
        <header className="binary-preview-head">
          <h2 className="binary-preview-title" id="binary-preview-title" title={meta.path}>
            {name}
          </h2>
          <button
            type="button"
            className="binary-preview-close"
            data-testid="binary-preview-close"
            aria-label="Close preview"
            ref={closeRef}
            onClick={() => onClose()}
          >
            ✕
          </button>
        </header>

        <div className="binary-preview-stage" data-testid="binary-preview-stage">
          {state.kind === "loading" && <p className="binary-preview-note">Loading…</p>}
          {state.kind === "missing" && (
            <p className="binary-preview-note" data-testid="binary-preview-missing">
              These bytes aren&rsquo;t on this device yet.
            </p>
          )}
          {(state.kind === "raster" || state.kind === "svg") && (
            <img
              className="binary-preview-image"
              data-testid="binary-preview-image"
              src={state.url}
              alt={name}
            />
          )}
          {state.kind === "none" && (
            <p className="binary-preview-note" data-testid="binary-preview-noinline">
              No inline preview for this file type — download it to open.
            </p>
          )}
        </div>

        <dl className="binary-preview-meta">
          <div>
            <dt>Path</dt>
            <dd data-testid="binary-preview-path">{meta.path}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(meta.size)}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{meta.mime || "unknown"}</dd>
          </div>
          <div>
            <dt>Hash</dt>
            <dd className="binary-preview-hash">{meta.hash.slice(0, 12)}…</dd>
          </div>
        </dl>

        <footer className="binary-preview-actions">
          <button
            type="button"
            className="binary-preview-download"
            data-testid="binary-preview-download"
            disabled={state.kind === "missing"}
            onClick={() => onDownload()}
          >
            Download
          </button>
        </footer>
      </div>
    </div>
  );
}
