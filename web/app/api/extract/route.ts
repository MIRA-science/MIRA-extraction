/**
 * POST /api/extract — run the parent library's engine server-side.
 *
 * Accepts multipart/form-data:
 *   - file?      a .pdf/.txt/.md upload (PDF is parsed here via pdf.js)
 *   - text?      raw pasted paper text (used when no file is given)
 *   - filename?  the original name when the browser pre-extracted a PDF's text
 *   - apiKey?    per-run OpenRouter key override (else process.env.OPENROUTER_API_KEY)
 *
 * Streams newline-delimited JSON: "status" lines describe the current stage,
 * "ping" lines keep proxies from dropping the long-lived connection, and a final
 * "result"/"error" line carries the payload — the classified graph plus
 * `extractedText` (the text the model saw) so the client can check each anchor
 * quote verbatim against the source.
 *
 * The OpenRouter key never reaches the browser: it is read from the environment
 * (or the request body) here on the server and used only for the model calls.
 */
import { NextResponse } from "next/server";
import { decomposeText, type CoreProgress } from "../../../../src/core.ts";
import { SINGLE_CALL_MAX } from "../../../../src/chunk.ts";
import { pdfToText } from "../../../lib/pdf.ts";

// Turn a core pipeline event into a short human-readable status line for the UI.
function statusLine(e: CoreProgress): string {
  switch (e.phase) {
    case "chunked":
      return "Analyzing the whole paper in one model call…";
    case "decomposing":
      return "Analyzing the paper…";
    case "generating":
      return e.kind === "reasoning"
        ? `The model is reasoning — ${e.chars.toLocaleString()} characters of thinking so far…`
        : `The model is writing the graph — ${e.chars.toLocaleString()} characters so far…`;
    case "decomposed":
      return "Building the graph…";
  }
}

export const runtime = "nodejs";
// Free-tier generations are slow; requires Fluid Compute for >300s when deployed.
export const maxDuration = 800;

// Cap how much extracted text we echo back for anchor-matching. Keeps the
// response payload sane for very long papers.
const MAX_ECHO_CHARS = 400_000;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const pastedText = (form.get("text") as string | null)?.trim() || "";
    const filename = (form.get("filename") as string | null)?.trim() || "";
    const apiKey = (form.get("apiKey") as string | null)?.trim() || undefined;

    if (!apiKey && !process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        { error: "No OpenRouter key. Set OPENROUTER_API_KEY in web/.env.local, or paste a key in the UI." },
        { status: 400 },
      );
    }

    // Resolve the paper text. PDFs go through pdf.js (server-side); .txt/.md are
    // decoded straight from the upload; otherwise we use the pasted text.
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
      sourceLabel = filename || "(pasted text)";
    } else {
      return NextResponse.json({ error: "Provide a file or some pasted text." }, { status: 400 });
    }

    if (!text.trim()) {
      return NextResponse.json(
        { error: "No readable text could be extracted — a scanned/image-only PDF has no text layer. Try a .txt/.md." },
        { status: 400 },
      );
    }

    // One paper = one model call, never chunked. Over the limit → a typed
    // refusal the UI turns into the "let us take a look" submission panel.
    if (text.length > SINGLE_CALL_MAX) {
      return NextResponse.json(
        {
          error: `This paper is ${text.length.toLocaleString()} characters — over the ${SINGLE_CALL_MAX.toLocaleString()}-character single-call limit.`,
          code: "paper-too-big",
          chars: text.length,
          limit: SINGLE_CALL_MAX,
        },
        { status: 413 },
      );
    }

    const key = apiKey || process.env.OPENROUTER_API_KEY || "";

    // Timed server logs so a stalled run is diagnosable: seconds since request start.
    const t0 = Date.now();
    const log = (msg: string) => console.log(`[extract +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
    log(`start — ${text.length} chars, source="${sourceLabel}"`);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch { /* closed */ }
        };
        send({ type: "status", message: "Reading the paper…" }); // first bytes → proxies commit
        const beat = setInterval(() => send({ type: "ping" }), 3_000);
        try {
          const result = await decomposeText(text, {
            apiKey: key,
            onProgress: (e) => {
              log(`phase=${e.phase} ${JSON.stringify(e)}`);
              send({ type: "status", message: statusLine(e) });
            },
          });
          log(`done — ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.stats.pieces} pieces, ${result.flakes.length} flakes`);
          send({
            type: "result",
            data: {
              source: sourceLabel,
              models: result.models,
              pieces: result.stats.pieces,
              piecesDecomposed: result.stats.piecesDecomposed,
              flakes: result.flakes,
              paper: result.paper,
              nodes: result.nodes,
              edges: result.edges,
              dropped: result.dropped,
              mergeFolded: result.stats.merge.collapsed,
              consolidation: result.stats.consolidation,
              extractedText: text.slice(0, MAX_ECHO_CHARS),
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`ERROR — ${message}`);
          send({ type: "error", message });
        } finally {
          clearInterval(beat);
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
