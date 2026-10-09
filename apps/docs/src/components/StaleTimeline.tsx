import React, { useId, useState } from "react";
import { phaseAt } from "../models/stale-timeline.js";
import type { TimelineState } from "../models/stale-timeline.js";
import "./StaleTimeline.css";

interface Marker {
  t: number;
  kind: "fetch" | "read" | "expiry";
}

const W = 600;
const PAD = 16;

export function StaleTimeline({ startAt = 0 }: { startAt?: number }) {
  // The clock is plain state: nothing here waits in real time.
  const [now, setNow] = useState(startAt);
  const [staleTime, setStaleTime] = useState(2000);
  const [gcTime, setGcTime] = useState(5000);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const s: TimelineState = { fetchedAt, staleTime, gcTime };
  const phase = phaseAt(s, now);
  const expiresAt = fetchedAt !== null ? fetchedAt + gcTime : null;

  const say = (m: string) => setLog((l) => [...l, `t=${now}: ${m}`]);
  const mark = (kind: Marker["kind"], t = now) => setMarkers((m) => [...m, { t, kind }]);

  function fetchNow() {
    setFetchedAt(now);
    mark("fetch");
    say(phase === "expired" ? "fetch (entry had expired, cold start)" : "fetch");
  }

  function readQuery() {
    mark("read");
    if (phase === "empty") {
      setFetchedAt(now);
      return say("read: nothing cached, cold load");
    }
    if (phase === "expired") {
      setFetchedAt(now);
      return say("read: expired, cold load (as after a reload from SQLite)");
    }
    if (phase === "fresh") return say("read: fresh, served from cache");
    setFetchedAt(now);
    say("read: stale, served from cache plus background revalidation; success resets both windows");
  }

  function advance(ms: number) {
    const next = now + ms;
    if (expiresAt !== null && now <= expiresAt && next > expiresAt) mark("expiry", expiresAt);
    setNow(next);
  }

  function reset() {
    setNow(startAt);
    setFetchedAt(null);
    setMarkers([]);
    setLog([]);
  }

  const horizon = Math.max(1000, now, fetchedAt !== null ? fetchedAt + staleTime : 0, expiresAt ?? 0) * 1.1;
  const x = (t: number) => PAD + (Math.min(t, horizon) / horizon) * (W - 2 * PAD);
  const uid = useId().replace(/:/g, "");
  const hatchStale = `st-hatch-stale-${uid}`;
  const hatchExpired = `st-hatch-expired-${uid}`;
  const freshEnd = fetchedAt !== null ? fetchedAt + staleTime : 0;
  const freshDrawEnd = expiresAt !== null ? Math.min(freshEnd, expiresAt) : freshEnd;
  const staleEnd = expiresAt ?? horizon;
  const w = (from: number, to: number) => Math.max(0, x(to) - x(from));

  return (
    <section className="st" aria-labelledby="st-title">
      <h3 id="st-title" className="st-title">Stale and expiry timeline</h3>
      <p className="st-note">
        Simulation on a manual clock. <code>staleTime</code> is a per-query option (falling back to the engine's{" "}
        <code>defaultStaleTime</code>); <code>gcTime</code> here stands for the engine-wide{" "}
        <code>defaultGcTime</code>, because ordinary queries have no per-query <code>gcTime</code> (only stream
        queries do). On every successful fetch QueryEngine stamps <code>stale_at = fetch time + staleTime</code> and{" "}
        <code>expires_at = fetch time + gcTime</code>. Both are fixed at write time; observers play no part. Staleness
        is judged only when a read happens: a fresh read is served from cache, a stale read is served from cache and
        triggers a background revalidation whose success resets both windows. Expiry is checked lazily, only when a
        record is loaded from SQLite (for example after a reload); a record already in memory is never evicted by
        time. The engine has no built-in focus or online refetch: your app wires those up and calls the query
        itself. Changing the two inputs below re-draws the current entry as if it had been fetched with the new
        values. In the engine, a <code>staleTime</code> passed to a read overrides the stored <code>stale_at</code>{" "}
        for that read, while the expiry window is set once on the engine and cannot be changed per read.
      </p>
      <div className="st-controls">
        <label>
          staleTime (ms)
          <input type="number" min={0} step={500} value={staleTime} onChange={(e) => setStaleTime(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>
          gcTime (ms)
          <input type="number" min={0} step={500} value={gcTime} onChange={(e) => setGcTime(Math.max(0, Number(e.target.value) || 0))} />
        </label>
      </div>
      <div className="st-buttons" role="group" aria-label="Timeline actions">
        <button type="button" className="btn btn-primary" onClick={fetchNow}>Fetch</button>
        <button type="button" className="btn btn-secondary" onClick={readQuery}>Read query</button>
        <button type="button" className="btn btn-secondary" onClick={reset}>Reset timeline</button>
      </div>
      <div className="st-buttons" role="group" aria-label="Advance the clock">
        {[1, 5, 30].map((sec) => (
          <button key={sec} type="button" className="btn btn-secondary" onClick={() => advance(sec * 1000)}>
            Advance {sec}s
          </button>
        ))}
      </div>
      <p className="st-readout">
        Clock: <span data-testid="timeline-clock">{now}</span> ms. Phase if read now: <strong data-testid="timeline-phase">{phase}</strong>.
      </p>
      <div className="st-scroll" tabIndex={0} role="region" aria-label="Stale and expiry timeline, scrollable">
        <svg
          className="st-svg"
          viewBox={`0 0 ${W} 110`}
          role="img"
          aria-label={`Timeline at ${now} ms: phase ${phase}. Fresh until ${fetchedAt !== null ? freshEnd : "n/a"} ms, then stale${expiresAt !== null ? `, expired after ${expiresAt} ms` : ""}. Markers: ${markers.map((m) => `${m.kind} at ${m.t}`).join(", ") || "none"}.`}
        >
          <defs>
            <pattern id={hatchStale} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="st-stale" />
              <line x1="0" y1="0" x2="0" y2="6" className="st-hatch" />
            </pattern>
            <pattern id={hatchExpired} width="6" height="6" patternUnits="userSpaceOnUse">
              <rect width="6" height="6" className="st-expired" />
              <circle cx="3" cy="3" r="1" className="st-hatch-dot" />
            </pattern>
          </defs>
          {fetchedAt !== null && (
            <>
              <rect className="st-fresh" x={x(fetchedAt)} y={30} height={30} width={w(fetchedAt, freshDrawEnd)} />
              {freshEnd < (expiresAt ?? horizon) && (
                <rect fill={`url(#${hatchStale})`} x={x(freshEnd)} y={30} height={30} width={w(freshEnd, staleEnd)} />
              )}
              {expiresAt !== null && (
                <rect fill={`url(#${hatchExpired})`} x={x(expiresAt)} y={30} height={30} width={w(expiresAt, horizon)} />
              )}
              <text className="st-phase-text" x={x(fetchedAt) + 4} y={49}>fresh</text>
              {freshEnd < (expiresAt ?? horizon) && w(freshEnd, staleEnd) > 40 && (
                <text className="st-phase-text" x={x(freshEnd) + 4} y={49}>stale</text>
              )}
              {expiresAt !== null && w(expiresAt, horizon) > 50 && (
                <text className="st-phase-text" x={x(expiresAt) + 4} y={49}>expired</text>
              )}
            </>
          )}
          <line className="st-axis" x1={PAD} x2={W - PAD} y1={70} y2={70} />
          {markers.map((m, i) => (
            <MarkerShape key={i} kind={m.kind} cx={x(m.t)} cy={22} />
          ))}
          <line className="st-now" x1={x(now)} x2={x(now)} y1={20} y2={80} />
          <text className="st-label" x={x(now)} y={96} textAnchor="middle">now {now}</text>
        </svg>
      </div>
      <ul className="st-legend" aria-label="Legend">
        <li><span className="st-key st-key-fresh" /> fresh: before fetch + staleTime</li>
        <li><span className="st-key st-key-stale" /> stale: served from cache, read revalidates</li>
        <li><span className="st-key st-key-expired" /> expired: after fetch + gcTime, next load is cold</li>
        <li><span className="st-glyph" aria-hidden="true">●</span> fetch marker</li>
        <li><span className="st-glyph" aria-hidden="true">■</span> read marker</li>
        <li><span className="st-glyph" aria-hidden="true">◆</span> expiry marker (fetch + gcTime)</li>
      </ul>
      <ol className="st-log" role="log" aria-live="polite" aria-label="Timeline log">
        {log.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
    </section>
  );
}

function MarkerShape({ kind, cx, cy }: { kind: Marker["kind"]; cx: number; cy: number }) {
  if (kind === "read") return <rect className="st-mark st-mark-read" x={cx - 5} y={cy - 5} width={10} height={10} />;
  if (kind === "expiry") return <path className="st-mark st-mark-expiry" d={`M ${cx} ${cy - 7} L ${cx + 7} ${cy} L ${cx} ${cy + 7} L ${cx - 7} ${cy} z`} />;
  return <circle className="st-mark st-mark-fetch" cx={cx} cy={cy} r={5} />;
}
