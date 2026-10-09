import React, { useMemo, useState } from "react";
import "./ucb1-visualiser.css";
import {
  FrameType,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  describeHeader,
  encodeFrame,
  toHex,
} from "../models/ucb1-codec.js";
import {
  hubPublish,
  type PublishResult,
  type SimProcess,
} from "../models/ucb1-hub.js";

const PROCESS_NAMES = [
  "Process A",
  "Process B",
  "Process C",
  "Process D",
] as const;
type Corruption = "none" | "magic" | "flags" | "length";

interface Outcome {
  result: PublishResult;
}

const PUBLISHER = PROCESS_NAMES[0];
const FILTER_OPTIONS = [
  { value: "", label: "none (receives everything)" },
  { value: "cache.invalidate", label: "kind / tag / topic: cache.invalidate" },
  { value: "other.topic", label: "kind / tag / topic: other.topic" },
  { value: "*", label: "* (everything)" },
] as const;

function corrupt(bytes: Uint8Array, kind: Corruption): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (kind === "magic") out[0] = 0x58; // 'X'
  if (kind === "flags") view.setUint8(5, 1);
  if (kind === "length") view.setUint32(8, MAX_PAYLOAD_SIZE + 1, false);
  return out;
}

const typeEntries = Object.entries(FrameType);

export function Ucb1Visualiser({ headingLevel: Title = "h1" }: { headingLevel?: "h1" | "h2" } = {}) {
  const [typeValue, setTypeValue] = useState<number>(FrameType.PUBLISH);
  const [payloadText, setPayloadText] = useState(
    '{"topic":"cache.invalidate","key":"user:42"}',
  );
  const [count, setCount] = useState(3);
  const [filterOf, setFilterOf] = useState<Record<string, string>>({});
  const [inbox, setInbox] = useState<Record<string, string[]>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);

  const processes = PROCESS_NAMES.slice(0, count);

  const built = useMemo(() => {
    try {
      const bytes = encodeFrame(typeValue, JSON.parse(payloadText));
      return { bytes, error: null as string | null };
    } catch (err) {
      return {
        bytes: null,
        error: err instanceof Error ? err.message : "Invalid payload",
      };
    }
  }, [typeValue, payloadText]);

  const fields = built.bytes ? describeHeader(built.bytes) : [];

  function publish(kind: Corruption) {
    if (!built.bytes) {
      setComposeError(
        `Cannot compose frame: ${built.error ?? "invalid payload"}`,
      );
      return;
    }
    setComposeError(null);
    const sim: SimProcess[] = processes.map((p) => ({
      name: p,
      filters: filterOf[p] ? [filterOf[p]!] : [],
    }));
    const wire = corrupt(built.bytes, kind);
    const result = hubPublish(wire, sim, PUBLISHER);
    setOutcome({ result });
    if (result.ok) {
      setInbox((prev) => {
        const next = { ...prev };
        for (const d of result.delivered) {
          next[d.process] = [
            ...(next[d.process] ?? []),
            JSON.stringify(d.frame.payload),
          ];
        }
        return next;
      });
    }
  }

  function summary(): string {
    if (!outcome) return "No frame published yet.";
    const { result } = outcome;
    if (!result.ok) {
      return `The hub's decoder threw ${result.error ?? "an error"} and swallowed it. ${PUBLISHER}'s connection dropped: the hub destroyed the socket and sent no ERROR frame. Delivered to 0 processes. The simulation reconnects the publisher automatically for the next publish.`;
    }
    if (result.waiting)
      return "Incomplete frame, hub waits for more bytes. Delivered to 0 processes.";
    const type = result.frameType ?? "frame";
    if (type !== "PUBLISH") {
      return `Accepted a ${type} frame, but only PUBLISH frames fan out as EVENT. Delivered to 0 processes.`;
    }
    const n = new Set(result.delivered.map((d) => d.process)).size;
    return `Accepted a PUBLISH frame. Delivered to ${n} ${n === 1 ? "process" : "processes"}.`;
  }

  return (
    <section className="ucb1">
      <Title className="ucb1__title">UCB1 Event Bus</Title>
      <p className="ucb1__lead">
        Compose a UCB1 frame, inspect its 12-byte big-endian header, publish it
        through a simulated hub, and inject a corrupted frame to see the hub
        drop the publisher.
      </p>

      <div className="ucb1__grid">
        <div className="ucb1__panel">
          <h2 className="ucb1__h2">Compose frame</h2>
          <label className="ucb1__field">
            <span>Frame type</span>
            <select
              value={typeValue}
              onChange={(e) => setTypeValue(Number(e.target.value))}
            >
              {typeEntries.map(([name, v]) => (
                <option key={name} value={v}>
                  {name} (0x{v.toString(16).padStart(2, "0")})
                </option>
              ))}
            </select>
          </label>
          <label className="ucb1__field">
            <span>JSON payload</span>
            <textarea
              rows={3}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              spellCheck={false}
            />
          </label>
          {built.error && (
            <p className="ucb1__error" role="alert">
              Payload error: {built.error}
            </p>
          )}
          {composeError && (
            <p className="ucb1__error" role="alert">
              {composeError}
            </p>
          )}
        </div>

        <div className="ucb1__panel">
          <h2 className="ucb1__h2">Hub and processes</h2>
          <label className="ucb1__field">
            <span>Number of processes</span>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </label>
          <fieldset className="ucb1__subs">
            <legend>Topic filters</legend>
            <p className="ucb1__hint">
              {PUBLISHER} is the publisher and never receives its own event. A
              process with no filter receives every event; otherwise only events
              whose payload kind, topic, or any entry in tags exactly matches
              the filter (or any event, with *).
            </p>
            {processes.slice(1).map((p) => (
              <label key={p} className="ucb1__field ucb1__filter">
                <span>Filter for {p}</span>
                <select
                  value={filterOf[p] ?? ""}
                  onChange={(e) =>
                    setFilterOf((f) => ({ ...f, [p]: e.target.value }))
                  }
                >
                  {FILTER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
          <div className="ucb1__buttons">
            <button type="button" onClick={() => publish("none")}>
              Publish frame
            </button>
            <button
              type="button"
              className="ucb1__danger"
              onClick={() => publish("magic")}
            >
              Inject bad magic
            </button>
            <button
              type="button"
              className="ucb1__danger"
              onClick={() => publish("flags")}
            >
              Inject non-zero flags
            </button>
            <button
              type="button"
              className="ucb1__danger"
              onClick={() => publish("length")}
            >
              Inject oversized length
            </button>
          </div>
        </div>
      </div>

      <div
        className="ucb1__status"
        role="status"
        aria-live="polite"
        data-state={outcome ? (outcome.result.ok ? "ok" : "rejected") : "idle"}
      >
        {outcome && (
          <strong>
            {outcome.result.ok ? "ACCEPTED" : "CONNECTION DROPPED"}{" "}
          </strong>
        )}
        {summary()}
      </div>

      <aside className="ucb1__note" data-testid="ucb1-differs">
        <h2 className="ucb1__h2">How this differs from the real hub</h2>
        <ul>
          <li>
            The codec here is a browser model checked byte-for-byte against the
            real one.
          </li>
          <li>
            There is no HELLO/token handshake in the simulation. The real hub
            answers a first frame that is not a valid HELLO with ERROR
            INVALID_TOKEN, then closes the socket.
          </li>
          <li>
            Real frame handling: PING gets PONG, SUBSCRIBE and UNSUBSCRIBE
            change a client's filters, RESYNC replays the change log, BYE closes
            the socket, and other or unknown types are silently ignored. Only
            PUBLISH is modelled here.
          </li>
          <li>
            A slow consumer gets a RESYNC frame (reason SLOW_CONSUMER) instead
            of the EVENT; not simulated.
          </li>
          <li>
            A malformed frame makes the real hub destroy the sender's socket
            without any reply, as shown above. A real client would have to
            reconnect and send HELLO; the simulation reconnects the publisher
            automatically for the next publish.
          </li>
        </ul>
      </aside>

      <h2 className="ucb1__h2">
        Frame bytes ({built.bytes ? built.bytes.length : 0} total, header{" "}
        {HEADER_SIZE})
      </h2>
      <div
        className="ucb1__scroll"
        tabIndex={0}
        role="region"
        aria-label="Header fields table, scrollable"
      >
        <table className="ucb1__table">
          <caption className="ucb1__sr">Header fields</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Bytes</th>
              <th scope="col">Hex</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.name}>
                <th scope="row">{f.name}</th>
                <td>
                  {f.offset}..{f.offset + f.length - 1}
                </td>
                <td className="ucb1__mono">{toHex(f.bytes)}</td>
                <td className="ucb1__mono">{f.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {built.bytes && (
        <div
          className="ucb1__scroll"
          tabIndex={0}
          role="region"
          aria-label="Full frame hex dump, scrollable"
        >
          <pre className="ucb1__dump">{toHex(built.bytes)}</pre>
        </div>
      )}

      <h2 className="ucb1__h2">Process inboxes</h2>
      <div className="ucb1__procs">
        {processes.map((p) => {
          const msgs = inbox[p] ?? [];
          return (
            <div key={p} className="ucb1__proc" data-testid={`inbox-${p}`}>
              <h3 className="ucb1__h3">
                {p}{" "}
                <span className="ucb1__badge">
                  {p === PUBLISHER
                    ? outcome && !outcome.result.ok
                      ? "publisher, connection dropped"
                      : "publisher, skipped (never receives its own event)"
                    : filterOf[p]
                      ? `filter: ${filterOf[p]}`
                      : "no filter (receives everything)"}
                </span>
              </h3>
              <p className="ucb1__count">Received: {msgs.length}</p>
              <ul className="ucb1__list">
                {msgs.map((m, i) => (
                  <li key={i} className="ucb1__mono">
                    EVENT {m}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
