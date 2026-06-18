/**
 * Text extraction. .txt/.md read straight through; .pdf via pdfjs-dist's legacy
 * (Node) build, lazy-loaded so the text path runs with no dependency at all.
 *
 * pdf.js yields positioned text fragments, not lines — column reconstruction for
 * multi-column academic PDFs is a known weak spot (the model reads a bounded prefix
 * anyway). If you have cleaner text, pass a .txt/.md instead.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

export async function extractText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return readFileSync(path, "utf8");
  }
  if (ext === ".pdf") {
    let pdfjs: any;
    try {
      pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      throw new Error(
        "PDF support needs pdfjs-dist — run `npm install` in this repo, " +
          "or pass an already-extracted .txt/.md instead.",
      );
    }
    const data = new Uint8Array(readFileSync(path));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.map((it: any) => ("str" in it ? it.str : "")).join(" "));
    }
    return pages.join("\n\n");
  }
  throw new Error(`unsupported input ${ext || "(no extension)"} — use .pdf, .txt, or .md`);
}
