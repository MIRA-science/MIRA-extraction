/**
 * Browser-side PDF → text. We parse the PDF in the browser and POST only the resulting TEXT,
 * so a large PDF never travels to the server as raw bytes.
 *
 * WHY: Vercel rejects a Function request body over ~4.5 MB at the platform edge — before our
 * code runs — with a plain-text "Request Entity Too Large" (HTTP 413). The client used to call
 * res.json() on that and choke with "Unexpected token 'R', \"Request En\"... is not valid JSON".
 * Extracted text is a tiny fraction of the PDF's size, so sending text sidesteps the limit.
 *
 * Mirrors the server path (lib/pdf.ts) but uses pdf.js's browser build + a bundled module
 * worker. The call site falls back to a server-side file upload if this throws or returns
 * empty (a scanned/image-only PDF), so behaviour is never worse than before.
 */
export async function pdfToTextInBrowser(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // Load the worker from public/ (copied there, version-matched, by scripts/copy-pdf-worker.mjs).
  // A runtime string URL — not new URL(..., import.meta.url) — so the bundler doesn't try to
  // resolve/inline the externalized pdfjs ESM file at build time. workerPort lets us force a
  // module worker, which the minified .mjs worker requires.
  pdfjs.GlobalWorkerOptions.workerPort = new Worker("/pdf.worker.min.mjs", { type: "module" });
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}
