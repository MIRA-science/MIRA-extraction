import "server-only";
import { createRequire } from "node:module";

/**
 * Extract text from a PDF, server-side. Mirrors the parent library's extractText() PDF
 * path, but lives inside this app for two reasons:
 *
 *  1. As a first-party import, `serverExternalPackages: ["pdfjs-dist"]` reliably keeps
 *     pdf.js out of the bundle.
 *  2. We pin GlobalWorkerOptions.workerSrc to the real worker file in node_modules. Without
 *     this, pdf.js falls back to a "fake worker" that dynamically imports the worker from a
 *     bundler-mangled path (the `.next/server/vendor-chunks/pdf.worker.mjs` that doesn't
 *     exist) and the parse fails.
 *
 * pdf.js yields positioned text fragments, not lines — column reconstruction for
 * multi-column PDFs is weak (same caveat as the CLI). Clean .txt/.md gives better results.
 */

/**
 * pdf.js needs the browser globals DOMMatrix / ImageData / Path2D, which Node lacks. It ships
 * a polyfill that `require("@napi-rs/canvas")`, but that require is invisible to Next's file
 * tracer, so on Vercel the canvas package never reaches the serverless function and pdf.js
 * throws "DOMMatrix is not defined". We import the same package from first-party code (which
 * IS traced) and install the globals ourselves, before pdf.js is evaluated.
 */
async function ensurePdfGlobals(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix !== "undefined") return;
  try {
    const canvas = await import("@napi-rs/canvas");
    g.DOMMatrix ??= canvas.DOMMatrix;
    g.ImageData ??= canvas.ImageData;
    g.Path2D ??= canvas.Path2D;
  } catch {
    // If canvas is unavailable, pdf.js will warn; simple text-only PDFs may still parse.
  }
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  await ensurePdfGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    // Resolve the worker via a non-literal specifier so the bundler doesn't try to
    // statically resolve (and warn about) this ESM file — we want a runtime resolve only.
    const nodeRequire = createRequire(import.meta.url);
    const workerSpec = ["pdfjs-dist", "legacy", "build", "pdf.worker.mjs"].join("/");
    pdfjs.GlobalWorkerOptions.workerSrc = nodeRequire.resolve(workerSpec);
  } catch {
    // Fall back to the default fake-worker resolution if the explicit resolve fails.
  }
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return pages.join("\n\n");
}
