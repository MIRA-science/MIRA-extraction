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
export async function pdfToText(data: Uint8Array): Promise<string> {
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
