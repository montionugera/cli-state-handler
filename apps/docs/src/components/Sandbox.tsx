import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHashRoute } from "../router.js";
import { transpile } from "../sandbox/transpile.js";
import { buildSandboxProgram, buildSrcdoc, RUN_LIMIT_MS } from "../sandbox/program.js";
import { parseSandboxMessage, type LogLevel } from "../sandbox/protocol.js";
import { presets } from "../sandbox/presets.js";
import "./Sandbox.css";

const MAX_LINES = 500;
const MAX_ERRORS = 50;
const MAX_MESSAGES = 2000;
type Status = "idle" | "running" | "finished" | "stopped";
interface ConsoleLine {
  id: number;
  level: LogLevel;
  text: string;
}
interface ErrorItem {
  id: number;
  text: string;
}
interface Frame {
  runId: number;
  srcdoc: string;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: "Ready.",
  running: "Running. Output from timers and async code is captured until the time limit.",
  finished: "Run finished.",
  stopped: "Run stopped."
};

export function Sandbox({ limitMs = RUN_LIMIT_MS }: { limitMs?: number }) {
  const { query } = useHashRoute();
  const urlPreset = query.get("preset");
  const initial = presets.find((p) => p.id === urlPreset) ?? presets[0];

  const [code, setCode] = useState(initial.code);
  const [presetId, setPresetId] = useState(initial.id);
  const [appliedUrl, setAppliedUrl] = useState(urlPreset);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [resetTick, setResetTick] = useState(0);

  const nextId = useRef(1);
  const runCounter = useRef(0);
  const doneRef = useRef(false);
  const messageCount = useRef(0);
  const frameLoads = useRef(0);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frameEl = useRef<HTMLIFrameElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const escaped = useRef(false);

  const loadPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setCode(p.code);
    setPresetId(p.id);
    return p;
  };

  // A different ?preset= in the URL (deep link or hashchange) selects that preset.
  if (urlPreset !== appliedUrl) {
    setAppliedUrl(urlPreset);
    const p = urlPreset ? loadPreset(urlPreset) : undefined;
    if (p && p.id !== presetId) {
      // A different preset arrived mid-run (deep link / hashchange): drop the frame and its output.
      setFrame(null);
      setLines([]);
      setErrors([]);
      setStatus("idle");
      setResetTick((n) => n + 1);
    }
  }

  const addError = useCallback((text: string) => {
    setErrors((prev) => [...prev, { id: nextId.current++, text }].slice(-MAX_ERRORS));
  }, []);

  const endRun = useCallback((next: Status) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setFrame(null);
    setStatus(next);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frameEl.current?.contentWindow ?? null;
      if (win === null || event.source !== win) return;
      // Count every message from the frame, well-formed or not, so malformed payloads cannot dodge the cap.
      if (++messageCount.current > MAX_MESSAGES) {
        runCounter.current++; // later messages from this run are ignored
        addError(`Run ended: it sent more than ${MAX_MESSAGES} messages, so the frame was discarded.`);
        endRun("stopped");
        return;
      }
      const msg = parseSandboxMessage(event.data, runCounter.current);
      if (!msg) return;
      if (msg.type === "log") {
        const line: ConsoleLine = { id: nextId.current++, level: msg.level, text: msg.text };
        setLines((prev) => [...prev, line].slice(-MAX_LINES));
      } else if (msg.type === "error") {
        addError(msg.text);
      } else {
        doneRef.current = true;
        setStatus("finished");
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      runCounter.current++; // makes in-flight runs bail out after unmount
      clearTimeout(timer.current);
    };
  }, [addError, endRun]);

  // Cancels the in-flight run when the URL switches to a different preset (see the render-time reset).
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    runCounter.current++;
    clearTimeout(timer.current);
    timer.current = undefined;
  }, [resetTick]);

  useLayoutEffect(() => {
    if (caret.current !== null && editor.current) {
      editor.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [code]);

  const run = async () => {
    endRun("idle");
    const runId = ++runCounter.current;
    doneRef.current = false;
    messageCount.current = 0;
    frameLoads.current = 0;
    setLines([]);
    setErrors([]);
    setStatus("running");

    const result = await transpile(code);
    if (runId !== runCounter.current) return;
    if (!result.ok) {
      addError(result.message);
      setStatus("idle");
      return;
    }
    let core: string;
    try {
      core = (await import("virtual:ucsa-core-iife")).default;
    } catch (err) {
      if (runId !== runCounter.current) return;
      addError(`Could not load the @montionugera/ucsa-core bundle: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("idle");
      return;
    }
    if (runId !== runCounter.current) return;
    setFrame({ runId, srcdoc: buildSrcdoc(buildSandboxProgram(core, result.js, runId)) });
    timer.current = setTimeout(() => {
      if (runId !== runCounter.current) return;
      if (doneRef.current) {
        endRun("finished");
      } else {
        addError(`Run ended after ${limitMs / 1000} s: the time limit was reached before the script finished.`);
        endRun("stopped");
      }
    }, limitMs);
  };

  // The first load event is the srcdoc document. A second one means the frame navigated itself elsewhere
  // (for example to a data: URL, which would not carry the srcdoc CSP), so the run is ended.
  const onFrameLoad = () => {
    if (++frameLoads.current <= 1) return;
    runCounter.current++;
    addError("Run ended: the frame navigated away from the sandbox document.");
    endRun("stopped");
  };

  const stop = () => {
    runCounter.current++;
    endRun("stopped");
  };

  const choosePreset = (id: string) => {
    stop();
    loadPreset(id);
    setLines([]);
    setErrors([]);
    setStatus("idle");
    if (urlPreset !== id) window.location.hash = `#/sandbox?preset=${id}`;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      escaped.current = true;
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (escaped.current) {
        escaped.current = false; // let the browser move focus
        return;
      }
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      caret.current = start + 2;
      setCode(el.value.slice(0, start) + "  " + el.value.slice(el.selectionEnd));
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) escaped.current = false;
  };

  const lineCount = code.split("\n").length;
  const gutterNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);
  const active = presets.find((p) => p.id === presetId) ?? presets[0];

  return (
    <div className="sbx">
      <h1>TypeScript Sandbox</h1>
      <p className="sbx-lead">
        Edit TypeScript, press Run, and watch real <code>@montionugera/ucsa-core</code> execute in your browser. Types are stripped,
        not checked.
      </p>

      <div className="sbx-presets" role="group" aria-label="Examples">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn btn-secondary"
            aria-pressed={p.id === presetId}
            onClick={() => choosePreset(p.id)}
          >
            {p.title}
          </button>
        ))}
      </div>
      <p className="sbx-desc">{active.description}</p>

      <div className="sbx-editor">
        <div className="sbx-gutter" ref={gutter} aria-hidden="true">
          {gutterNumbers.map((n) => (
            <span key={n} className="sbx-gutter-line">
              {n}
            </span>
          ))}
        </div>
        <textarea
          ref={editor}
          className="sbx-textarea"
          aria-label="TypeScript source"
          aria-describedby="sbx-keys"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            escaped.current = false;
          }}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      <p id="sbx-keys" className="sbx-hint">
        Tab inserts two spaces. To move focus out of the editor, press Escape and then Tab.
      </p>

      <div className="sbx-actions">
        <button type="button" className="btn btn-primary" onClick={() => void run()}>
          Run
        </button>
        <button type="button" className="btn btn-secondary" onClick={stop} disabled={frame === null}>
          Stop
        </button>
        <span className="sbx-status" role="status">{STATUS_TEXT[status]}</span>
        <span className="sbx-warn">A synchronous infinite loop can freeze the tab in some browsers.</span>
      </div>

      <h2 className="sbx-h2">Console</h2>
      <div className="sbx-console" role="log" aria-live="polite" aria-label="Console output">
        {lines.length === 0 ? <span className="sbx-empty">No output yet.</span> : null}
        {lines.map((l) => (
          <div key={l.id} className={`sbx-line sbx-line-${l.level}`}>
            {l.level === "log" ? null : <span className="sbx-tag">{l.level}</span>}
            <span className="sbx-text">{l.text}</span>
          </div>
        ))}
      </div>

      {errors.length > 0 ? (
        <div className="sbx-errors" role="alert">
          <h2 className="sbx-h2">Error</h2>
          {errors.map((e) => (
            <pre key={e.id} className="sbx-error-text">
              {e.text}
            </pre>
          ))}
        </div>
      ) : null}

      {frame ? (
        <iframe
          key={frame.runId}
          ref={frameEl}
          className="sbx-frame"
          title="Sandbox execution frame"
          sandbox="allow-scripts"
          srcDoc={frame.srcdoc}
          onLoad={onFrameLoad}
          data-run-id={frame.runId}
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}

      <div className="sbx-notes">
        <h2 className="sbx-h2">How it runs</h2>
        <ul>
          <li>
            Your code runs in a sandboxed frame with no access to this page, its storage or its origin. The frame's content
            security policy blocks direct <code>fetch</code>, <code>XMLHttpRequest</code> and <code>WebSocket</code> calls,
            but this is not a full network-isolation guarantee; a run that navigates the frame away is ended. Only{" "}
            <code>import ... from "@montionugera/ucsa-core"</code> is available; other imports fail.
          </li>
          <li>
            Each run uses a fresh frame. A run still going after {limitMs / 1000} seconds is ended by discarding the
            frame. A synchronous infinite loop cannot be interrupted by that timer.
          </li>
          <li>
            Dart and C# examples in this portal are read-only: there is no in-browser runtime for them, so only
            TypeScript runs here.
          </li>
        </ul>
      </div>
    </div>
  );
}
