/**
 * Copy pdf.js's worker into public/ so the browser can load it from a stable, same-origin URL
 * (/pdf.worker.min.mjs) that always matches the installed pdfjs-dist version. Runs as a
 * pre-dev/pre-build step (npm fires `predev`/`prebuild` automatically), so the worker stays in
 * lockstep with the API with no bundler asset-resolution and no third-party CDN at runtime.
 *
 * We resolve via package.json + a manual join rather than resolving the worker subpath
 * directly, so pdfjs-dist's `exports` map can't block resolution.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const src = join(pkgRoot, "build", "pdf.worker.min.mjs");

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, "..", "public");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, "pdf.worker.min.mjs"));
console.log("copy-pdf-worker: public/pdf.worker.min.mjs <-", src);
