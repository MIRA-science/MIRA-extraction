/**
 * POST /api/extract — run the parent library's decompose() server-side.
 *
 * Accepts multipart/form-data:
 *   - file?        a .pdf/.txt/.md upload (PDF is parsed here via the library's extractText)
 *   - text?        raw pasted paper text (used when no file is given)
 *   - attributedTo? DID stamped into provenance.wasAttributedTo (optional)
 *   - apiKey?      per-run OpenRouter key override (else process.env.OPENROUTER_API_KEY)
 *
 * Returns the full DecomposeResult plus `extractedText` — the text the model saw —
 * so the client can check each anchor quote verbatim against the source.
 *
 * The OpenRouter key never reaches the browser: it is read from the environment (or the
 * request body) here on the server and used only for the single model call.
 */
import { NextResponse } from "next/server";
import { decomposeText } from "../../../../src/core.ts";
import { pdfToText } from "../../../lib/pdf.ts";

export const runtime = "nodejs";
// Long papers fan out into several sequential Mistral calls (one per window); give them room.
export const maxDuration = 300;

// Cap how much extracted text we echo back for anchor-matching (the model only reads the
// first ~40K anyway). Keeps the response payload sane for very long papers.
const MAX_ECHO_CHARS = 200_000;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const pastedText = (form.get("text") as string | null)?.trim() || "";
    const attributedTo = (form.get("attributedTo") as string | null)?.trim() || undefined;
    const apiKey = (form.get("apiKey") as string | null)?.trim() || undefined;

    if (!apiKey && !process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        { error: "No OpenRouter key. Set OPENROUTER_API_KEY in web/.env.local, or paste a key in the UI." },
        { status: 400 },
      );
    }

    // Resolve the paper text. PDFs go through pdf.js (server-side); .txt/.md are decoded
    // straight from the upload; otherwise we use the pasted text.
    let text: string;
    let sourceLabel: string;
    if (file && typeof file !== "string" && file.size > 0) {
      const name = file.name || "upload";
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (ext === ".pdf") {
        text = await pdfToText(bytes);
      } else if (ext === ".txt" || ext === ".md" || ext === "") {
        text = Buffer.from(bytes).toString("utf8");
      } else {
        return NextResponse.json({ error: `Unsupported file type ${ext} — use .pdf, .txt, or .md.` }, { status: 400 });
      }
      sourceLabel = name;
    } else if (pastedText) {
      text = pastedText;
      sourceLabel = "(pasted text)";
    } else {
      return NextResponse.json({ error: "Provide a file or some pasted text." }, { status: 400 });
    }

    if (!text.trim()) {
      return NextResponse.json(
        { error: "No readable text could be extracted — a scanned/image-only PDF has no text layer. Try a .txt/.md." },
        { status: 400 },
      );
    }

    const key = apiKey || process.env.OPENROUTER_API_KEY || "";
    const slug = sourceLabel.replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "_") || "paper";

    // The model call takes ~1–3 min, during which we'd otherwise send nothing. On Vercel the
    // request passes through the edge, which drops a client connection that stays silent that
    // long — that's why it fails deployed but works on localhost (no proxy in between). So we
    // stream: emit whitespace keepalive bytes while the model runs, then the JSON payload at
    // the end. Leading whitespace is valid JSON, so the client still does res.json() unchanged.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(" ")); // first byte now → edge commits to the response
        const beat = setInterval(() => {
          try { controller.enqueue(encoder.encode(" ")); } catch { /* stream closed */ }
        }, 3_000);
        try {
          const result = await decomposeText(text, { apiKey: key, attributedTo, slug });
          const body = JSON.stringify({ ...result, source: sourceLabel, extractedText: text.slice(0, MAX_ECHO_CHARS) });
          controller.enqueue(encoder.encode(body));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(encoder.encode(JSON.stringify({ error: message })));
        } finally {
          clearInterval(beat);
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
