import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The typst compiler runs in a Web Worker (ES module). WASM is served from
// public/ (copied there by scripts/copy-wasm.mjs) so nothing is fetched from a
// CDN at runtime. The two typst WASM packages are excluded from dep
// pre-bundling — they are large and loaded as raw bytes by the worker.
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // Yjs (and the protocols built on it) MUST be singletons — two copies break
  // `instanceof` checks across @galley/collab, y-codemirror.next, and the app.
  resolve: { dedupe: ["yjs", "y-protocols", "lib0"] },
  optimizeDeps: {
    exclude: ["@myriaddreamin/typst-ts-web-compiler", "@myriaddreamin/typst-ts-renderer"],
  },
  // Vendor-split the framework JS so the entry chunk isn't a single ~1.2 MB blob
  // (L5-P3). The whole Yjs ecosystem is pinned into ONE chunk so it stays a
  // singleton (splitting it would reintroduce the duplicate-`instanceof` hazard
  // the `dedupe` above guards against). Route code is lazy-loaded in main.tsx, so
  // only the active route's app code ships on first paint. (The typst WASM seams
  // are already worker/raw-loaded and untouched by this.)
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](yjs|y-protocols|y-indexeddb|lib0|y-codemirror\.next)[\\/]/.test(id)) {
            return "yjs";
          }
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/](@codemirror|@lezer|codemirror)[\\/]/.test(id)) return "codemirror";
          return "vendor";
        },
      },
    },
  },
});
