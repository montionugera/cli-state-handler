import React, { useEffect, useRef, useState } from "react";
import { Badge, Button } from "@montionugera/joy-react";
import { guides, guideIds, platforms, type GuideId, type PlatformId, type Snippet } from "../content/guides/index.js";
import { Code, CodeTabs } from "./rich.js";
import "./multiplatform.css";

const PLATFORM_LABEL: Record<PlatformId, string> = {
  ts: "🟦 TypeScript (React / Node)",
  dart: "🎯 Dart 3+ (Flutter)",
  csharp: "🎮 C# Unity (.NET)",
};

const CONCEPT_ICON: Record<GuideId, string> = { swr: "⚡", timing: "⏱️", outbox: "📦", cas: "💾", wal: "🪵", ucb1: "🚌" };

type View = "tabs" | "side";

function SnippetView({ snippet, children }: { snippet: Snippet; children?: React.ReactNode }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);
  const scheduleReset = () => {
    if (!mounted.current) return;
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 2000);
  };
  const handleCopy = () => {
    if (!navigator.clipboard) {
      setStatus("failed");
      scheduleReset();
      return;
    }
    navigator.clipboard.writeText(snippet.code).then(
      () => { if (mounted.current) setStatus("copied"); },
      () => { if (mounted.current) setStatus("failed"); },
    ).finally(scheduleReset);
  };
  return (
    <section className="mp-snippet" aria-label={snippet.title}>
      <header className="mp-snippet__head">
        <span className="mp-snippet__title">{snippet.title}</span>
        {snippet.available && (
          <Button variant="outline" onClick={handleCopy}>
            {status === "copied" ? "✓ Copied to Clipboard" : status === "failed" ? "Copy failed" : "📋 Copy Code"}
          </Button>
        )}
      </header>
      {children ?? (snippet.available ? (
        <div className="mp-scroll" role="region" aria-label={`${snippet.title} code, scrollable`} tabIndex={0}>
          <Code code={snippet.code} language={snippet.lang} allowCopy={false} />
        </div>
      ) : (
        <p className="mp-unavailable"><strong>Not available on this platform.</strong></p>
      ))}
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
  // Tabs need a snippet on every platform; a guide with a gap keeps the plain buttons.
  const allAvailable = platforms.every((p) => guide[p].available);
  const isPlatform = (key: string): key is PlatformId => (platforms as readonly string[]).includes(key);

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
          <Badge variant="brand">3 Native Implementations</Badge>
        </div>

        <div className="mp-row" role="group" aria-label="Subsystem">
          {guideIds.map((id, i) => (
            <Button
              key={id}
              variant={concept === id ? "solid" : "outline"}
              aria-pressed={concept === id}
              onClick={() => setConcept(id)}
            >
              {`${CONCEPT_ICON[id]} ${i + 1}. ${guides[id].label}`}
            </Button>
          ))}
        </div>

        <div className="mp-row mp-row--split">
          {view === "tabs" && !allAvailable ? (
            <div className="mp-row" role="group" aria-label="Platform">
              {platforms.map((p) => (
                <Button
                  key={p}
                  variant={platform === p ? "solid" : "outline"}
                  aria-pressed={platform === p}
                  onClick={() => setPlatform(p)}
                >
                  {PLATFORM_LABEL[p]}
                </Button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="mp-row mp-viewtoggle" role="group" aria-label="Layout">
            <Button variant={view === "tabs" ? "solid" : "outline"} aria-pressed={view === "tabs"} onClick={() => setView("tabs")}>
              Tabs
            </Button>
            <Button variant={view === "side" ? "solid" : "outline"} aria-pressed={view === "side"} onClick={() => setView("side")}>
              Side by side
            </Button>
          </div>
        </div>

        {view === "side" ? (
          <div className="mp-side">
            {platforms.map((p) => (
              <SnippetView key={p} snippet={guide[p]} />
            ))}
          </div>
        ) : allAvailable ? (
          <SnippetView snippet={guide[platform]}>
            <CodeTabs
              aria-label="Platform code"
              items={platforms.map((p) => ({ key: p, language: guide[p].lang, label: PLATFORM_LABEL[p], code: guide[p].code }))}
              activeKey={platform}
              onChange={(key) => {
                if (isPlatform(key)) setPlatform(key);
              }}
              allowCopy={false}
            />
          </SnippetView>
        ) : (
          <SnippetView snippet={guide[platform]} />
        )}
      </div>
    </div>
  );
}
