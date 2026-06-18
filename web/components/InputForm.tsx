"use client";

import { useRef, useState } from "react";

export interface RunPayload {
  text: string;
  file: File | null;
  attributedTo: string;
  apiKey: string;
}

export default function InputForm({
  busy,
  onRun,
}: {
  busy: boolean;
  onRun: (p: RunPayload) => void;
}) {
  const [mode, setMode] = useState<"paste" | "upload">("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [attributedTo, setAttributedTo] = useState("");
  const [apiKey, setApiKey] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const canRun = !busy && (mode === "paste" ? text.trim().length > 0 : !!file);

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canRun) onRun({ text, file, attributedTo, apiKey });
      }}
    >
      <div className="tabs">
        <button type="button" className={mode === "paste" ? "tab active" : "tab"} onClick={() => setMode("paste")}>
          Paste text
        </button>
        <button type="button" className={mode === "upload" ? "tab active" : "tab"} onClick={() => setMode("upload")}>
          Upload file
        </button>
      </div>

      {mode === "paste" ? (
        <textarea
          className="textarea"
          placeholder="Paste the paper's text here (abstract + body works best)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <div className="dropzone" onClick={() => fileRef.current?.click()}>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <span className="file-pill">{file.name} <em>({Math.round(file.size / 1024)} KB)</em></span>
          ) : (
            <span className="muted">Click to choose a <b>.pdf</b>, <b>.txt</b>, or <b>.md</b></span>
          )}
        </div>
      )}

      <details className="advanced">
        <summary>Options</summary>
        <label className="field">
          <span>OpenRouter API key (optional)</span>
          <input
            type="password"
            placeholder="sk-or-…  (else uses server's OPENROUTER_API_KEY)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Attributed-to DID (optional)</span>
          <input
            type="text"
            placeholder="did:plc:…  (stamped into provenance)"
            value={attributedTo}
            onChange={(e) => setAttributedTo(e.target.value)}
            autoComplete="off"
          />
        </label>
      </details>

      <button className="run" type="submit" disabled={!canRun}>
        {busy ? "Extracting…" : "Extract graph"}
      </button>
      <p className="muted tiny">One LLM call · draft for review · nothing is published or signed.</p>
    </form>
  );
}
