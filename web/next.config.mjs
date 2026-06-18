import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API route reuses the parent library (../src), whose extractText() lazy-imports
  // pdfjs-dist. Keep pdfjs external so Next doesn't try to bundle its wasm/font assets;
  // Node resolves it from node_modules at runtime.
  serverExternalPackages: ["pdfjs-dist"],
  // We sit in a subfolder of a repo that has its own lockfile; pin the tracing root to
  // this app so file-tracing (and pdfjs resolution) is unambiguous.
  outputFileTracingRoot: here,
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
