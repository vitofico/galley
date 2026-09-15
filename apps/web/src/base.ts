/**
 * Deploy-base seam. Galley is served from the ROOT (`/`) in every deployment it
 * has ever had — `vite dev`, `vite preview`, the Playwright gate, the Docker
 * runtime stage, the k8s manifests — and from a SUBPATH only when the bundle is
 * built with an explicit Vite `--base` (the GitHub Pages demo builds with
 * `--base=/galley/`).
 *
 * Vite rewrites the URLs it OWNS: the `index.html` link/script tags, everything
 * under `assets/`, and `new URL("./x", import.meta.url)` worker specifiers. It
 * cannot rewrite a path the app BUILDS AT RUNTIME, and there are exactly three
 * of those: router pathnames (router.ts), the `public/` WASM + font URLs
 * (compiler-assets.ts), and share links (share.ts). They all come here.
 *
 * The pure core takes the base EXPLICITLY so it unit-tests in the Node gate with
 * no environment at all; the three live wrappers read `import.meta.env.BASE_URL`
 * lazily (so `vi.stubEnv` works, and so a context without `import.meta.env` can
 * never throw at module load). At the default base every function is the
 * IDENTITY on an app-absolute path — that is the invariant that keeps the
 * root-served deployments byte-for-byte unchanged.
 */

/** Normalize an absolute-path Vite base spelling into the canonical `/` or `/seg/` form. */
export function normalizeBase(base: string): string {
  const trimmed = base.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

/**
 * Prefix an APP-ABSOLUTE path (`/library`, `/join/x?role=editor`) with the
 * deploy base. Identity at the root base. A path that is not absolute (a bare
 * segment, or a full URL) is returned untouched — there is nothing to rebase.
 */
export function joinBase(base: string, path: string): string {
  const normalized = normalizeBase(base);
  if (normalized === "/") return path;
  if (!path.startsWith("/")) return path;
  return `${normalized.slice(0, -1)}${path}`;
}

/**
 * Strip the deploy base off a BROWSER pathname, yielding the app-absolute path
 * the router parses. Identity at the root base. The bare base (`/galley`, no
 * trailing slash — what a user typing the URL by hand lands on) maps to `/`.
 */
export function stripBaseFrom(base: string, pathname: string): string {
  const normalized = normalizeBase(base);
  if (normalized === "/") return pathname;
  const withoutTrailing = normalized.slice(0, -1);
  if (pathname === withoutTrailing) return "/";
  if (pathname.startsWith(normalized)) return pathname.slice(withoutTrailing.length);
  return pathname; // off-base: parse as-is rather than mangle it
}

/**
 * This bundle's deploy base, from Vite's build-time `BASE_URL`. Read lazily and
 * defensively: an environment without `import.meta.env` degrades to the root
 * base rather than throwing at import time.
 */
export function deployBase(): string {
  const raw = (import.meta.env as { BASE_URL?: string } | undefined)?.BASE_URL;
  return normalizeBase(typeof raw === "string" ? raw : "/");
}

/** {@link joinBase} against this bundle's deploy base. */
export function withBase(path: string): string {
  return joinBase(deployBase(), path);
}

/** {@link stripBaseFrom} against this bundle's deploy base. */
export function stripBase(pathname: string): string {
  return stripBaseFrom(deployBase(), pathname);
}
