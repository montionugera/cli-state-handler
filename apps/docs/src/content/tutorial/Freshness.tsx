import React from "react";
import { Callout } from "../../components/Prose.js";
import { StaleTimeline } from "../../components/StaleTimeline.js";
import { TimingPlayground } from "../../components/TimingPlayground.js";
import { TutorialPage } from "./TutorialPage.js";

export function Freshness() {
  return (
    <TutorialPage
      step={2}
      next={{ href: "#/tutorial-durable-cache", label: "Next: durable cache and WAL" }}
      intro={
        <>
          <h1>Freshness and Refetch Timing</h1>
          <p>
            When a fetch succeeds, the engine stamps two times on the entry: <code>stale_at</code> (fetch time plus
            <code> staleTime</code>, or the engine&apos;s <code>defaultStaleTime</code>, default 0) and <code>expires_at</code>
            (fetch time plus the engine&apos;s <code>defaultGcTime</code>, default 300000 ms; there is no per-query{" "}
            <code>gcTime</code> on <code>useQuery</code>/<code>fetchQuery</code>). Both are fixed when the entry is written.
          </p>
        </>
      }
      visualiser={
        <>
          <h2>Watch an entry go stale</h2>
          <StaleTimeline />
          <TimingPlayground headingLevel="h2" />
        </>
      }
      after={
        <>
          <h2>What you will see</h2>
          <p>
            In the timeline, fetch once, then advance the clock and read. Before <code>stale_at</code> the read is fresh. Between
            <code> stale_at</code> and <code>expires_at</code> it is stale: the read returns the cached data and starts a
            revalidation. After <code>expires_at</code> the next load is cold. The clock is plain state, so nothing waits in real
            time. The timing playground below it shows observer throttling and query debouncing.
          </p>
          <h2>The rules to remember</h2>
          <ul>
            <li>Staleness is judged only when a read happens. Nothing refetches by itself when the time passes.</li>
            <li>A <code>staleTime</code> passed to a read overrides the stored <code>stale_at</code> for that read.</li>
            <li>
              Expiry is checked lazily, only when a record is loaded from SQLite. A record already in memory is never evicted by
              time, and there is no observer-based garbage collection.
            </li>
            <li>
              <code>debounceMs</code> on <code>fetchQuery</code> resets one timer per key and gives every caller the final
              result. Observers take <code>throttleMs</code> and <code>debounceMs</code> to limit how often listeners run.
            </li>
          </ul>
          <Callout tone="warn" title="No automatic focus or online refetch">
            <code>FocusManager</code> and <code>OnlineManager</code> exist in the TypeScript core, but the engine does not call
            them. Your application has to wire them up and trigger the refetch. Dart has neither class; in Unity,
            <code> UcsaBehaviour</code> revalidates active subscribers on resume.
          </Callout>
        </>
      }
    />
  );
}
