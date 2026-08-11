/**
 * POST /api/oversize — the "paper too big? let us take a look" inbox.
 *
 * The extractor refuses papers over the single-call limit (it never chunks).
 * This endpoint receives the refused paper so a maintainer can review it —
 * these submissions are the test corpus for a future chunking system.
 *
 * Accepts multipart/form-data:
 *   - file      the paper (.pdf/.txt/.md), up to MAX_UPLOAD_BYTES
 *   - contact?  optional email/handle so we can follow up
 *   - chars?    the extracted-text length the refusal reported
 *
 * Stores the file plus a .meta.json sidecar in private Vercel Blob storage
 * under oversize/. Requires BLOB_READ_WRITE_TOKEN (auto-set when a Blob store
 * is connected to the Vercel project); without it, responds 503.
 */
import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXT = new Set([".pdf", ".txt", ".md"]);

export async function POST(req: Request) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json(
        { error: "Submissions aren't configured on this deployment (no blob storage). Please open an issue on GitHub instead." },
        { status: 503 },
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const contact = ((form.get("contact") as string | null) || "").trim().slice(0, 300);
    const chars = ((form.get("chars") as string | null) || "").trim().slice(0, 20);

    if (!file || typeof file === "string" || file.size === 0) {
      return NextResponse.json({ error: "No file received." }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "File is over the 100 MB submission limit." }, { status: 413 });
    }
    const name = file.name || "paper";
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return NextResponse.json({ error: `Unsupported file type ${ext} — submit a .pdf, .txt, or .md.` }, { status: 400 });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = name.replace(/[^\w.-]+/g, "_").slice(0, 120);
    const base = `oversize/${stamp}-${safeName}`;

    await put(base, file, { access: "private" });
    await put(
      `${base}.meta.json`,
      JSON.stringify({ originalName: name, bytes: file.size, extractedChars: chars || null, contact: contact || null, submittedAt: new Date().toISOString() }, null, 2),
      { access: "private", contentType: "application/json" },
    );

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
