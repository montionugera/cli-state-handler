import React, { useState } from "react";
import { guides, guideIds, platforms, type GuideId, type PlatformId, type Snippet } from "../content/guides/index.js";
import "./multiplatform.css";

const PLATFORM_LABEL: Record<PlatformId, string> = {
  ts: "🟦 TypeScript (React / Node)",
  dart: "🎯 Dart 3+ (Flutter)",
  csharp: "🎮 C# Unity (.NET)",
};

const CONCEPT_ICON: Record<GuideId, string> = { swr: "⚡", timing: "⏱️", outbox: "📦", cas: "💾", wal: "🪵", ucb1: "🚌" };

type View = "tabs" | "side";

function SnippetView({ snippet }: { snippet: Snippet }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const handleCopy = () => {
    if (!navigator.clipboard) {
      setStatus("failed");
      setTimeout(() => setStatus("idle"), 2000);
      return;
    }
    navigator.clipboard.writeText(snippet.code).then(
      () => setStatus("copied"),
      () => setStatus("failed"),
    ).finally(() => setTimeout(() => setStatus("idle"), 2000));
  };
  return (
    <section className="mp-snippet" aria-label={snippet.title}>
      <header className="mp-snippet__head">
        <span className="mp-snippet__title">{snippet.title}</span>
        {snippet.available && (
          <button className="btn btn-secondary" onClick={handleCopy}>
            {status === "copied" ? "✓ Copied to Clipboard" : status === "failed" ? "Copy failed" : "📋 Copy Code"}
          </button>
        )}
      </header>
      {snippet.available ? (
        <div className="mp-scroll" role="region" aria-label={`${snippet.title} code, scrollable`} tabIndex={0}>
          <pre className="mp-code"><code>{snippet.code}</code></pre>
        </div>
      ) : (
        <p className="mp-unavailable"><strong>Not available on this platform.</strong></p>
      )}
      <ul className="mp-notes">
        {snippet.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <p className="mp-src">
        Source: {snippet.sources.map((s, i) => (
          <React.Fragment key={s}>{i > 0 && ", "}<code>{s}</code></React.Fragment>
        ))}
      </p>
    </section>
  );
}

export function MultiPlatformDocs() {
  const [platform, setPlatform] = useState<PlatformId>("ts");
  const [concept, setConcept] = useState<GuideId>("swr");
  const [view, setView] = useState<View>("tabs");
  const guide = guides[concept];

  return (
    <div className="multiplatform-docs mp">
      <div className="card">
        <div className="mp-head">
          <div>
            <h1 className="mp-title">Multi-Platform Code Reference & Tutorial</h1>
            <p className="mp-lead">
              Cross-platform guide comparing UCSA on TypeScript Core, Dart / Flutter and C# Unity. Every snippet names the
              source file it was checked against; see the <a href="#/parity">parity matrix</a> for what each platform lacks.
            </p>
          </div>
          <span className="badge badge-cyan">3 Native Implementations</span>
        </div>

        <div className="mp-row" role="group" aria-label="Subsystem">
          {guideIds.map((id, i) => (
            <button
              key={id}
              className={`btn ${concept === id ? "btn-primary" : "btn-secondary"}`}
              aria-pressed={concept === id}
              onClick={() => setConcept(id)}
            >
              {`${CONCEPT_ICON[id]} ${i + 1}. ${guides[id].label}`}
            </button>
          ))}
        </div>

        <div className="mp-row mp-row--split">
          {view === "tabs" ? (
            <div className="mp-row" role="group" aria-label="Platform">
              {platforms.map((p) => (
                <button
                  key={p}
                  className={`btn ${platform === p ? "btn-primary" : "btn-secondary"}`}
                  aria-pressed={platform === p}
                  onClick={() => setPlatform(p)}
                >
                  {PLATFORM_LABEL[p]}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="mp-row mp-viewtoggle" role="group" aria-label="Layout">
            <button className={`btn ${view === "tabs" ? "btn-primary" : "btn-secondary"}`} aria-pressed={view === "tabs"} onClick={() => setView("tabs")}>
              Tabs
            </button>
            <button className={`btn ${view === "side" ? "btn-primary" : "btn-secondary"}`} aria-pressed={view === "side"} onClick={() => setView("side")}>
              Side by side
            </button>
          </div>
        </div>

        {view === "tabs" ? (
          <SnippetView snippet={guide[platform]} />
        ) : (
          <div className="mp-side">
            {platforms.map((p) => (
              <SnippetView key={p} snippet={guide[p]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
