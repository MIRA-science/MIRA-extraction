import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API route reuses the parent library (../src), whose extractText() lazy-imports
  // pdfjs-dist. Keep pdfjs external so Next doesn't try to bundle its wasm/font assets;
  // Node resolves it from node_modules at runtime. @napi-rs/canvas is pdf.js's source for
  // the DOMMatrix/Path2D/ImageData polyfills Node lacks — it's a native module, so it must
  // stay external (webpack can't bundle a .node binary) and be traced into the function.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  // We sit in a subfolder of a repo that has its own lockfile; pin the tracing root to
  // this app so file-tracing (and pdfjs resolution) is unambiguous.
  outputFileTracingRoot: here,
  // pdf.js loads its worker (pdf.worker.mjs) via a runtime fake-worker dynamic import that
  // the tracer can't follow, so the worker file never ships and parsing dies with "Cannot
  // find module .../pdf.worker.mjs". Force it (and its sibling builds) into the /api/extract
  // function. lib/pdf.ts pins GlobalWorkerOptions.workerSrc to this same file at runtime.
  outputFileTracingIncludes: {
    "/api/extract": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  // lib/pdf.ts resolves the pdf.js worker at runtime via createRequire (deliberately, so
  // pdf.js loads its worker from node_modules instead of a bundler-mangled path). Webpack
  // can't statically analyze that and emits a benign "Critical dependency" warning — silence
  // just that one.
  webpack: (config) => {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /lib[\\/]pdf\.ts/, message: /Critical dependency/ },
    ];
    return config;
  },
};

export default nextConfig;
