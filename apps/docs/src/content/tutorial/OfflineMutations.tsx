import React from "react";
import { Callout } from "../../components/Prose.js";
import { OutboxPlayground } from "../../components/OutboxPlayground.js";
import { TutorialPage } from "./TutorialPage.js";

export function OfflineMutations() {
  return (
    <TutorialPage
      step={4}
      next={{ href: "#/tutorial-ucb1", label: "Next: cross-process events over UCB1" }}
      intro={
        <>
          <h1>Offline Mutations with the Outbox</h1>
          <p>
            The outbox stores writes in SQLite so they survive a restart. You enqueue a mutation (endpoint, method, payload) and
            later call <code>replay</code> with a function that sends each one. A replay claims a batch, sends it in order and
            settles each mutation by the HTTP status it gets back.
          </p>
        </>
      }
      visualiser={<OutboxPlayground headingLevel="h2" />}
      after={
        <>
          <h2>What you will see</h2>
          <p>
            The playground starts offline. Enqueue a few mutations, choose a conflict policy, rate limit and batch size, go
            online and press Replay Outbox. The worker buttons answer an in-flight mutation with 200, 503, 409 or 400. Rows move
            between pending, in flight (leased) and failed, and completed ones are removed. The clock buttons advance time so
            you can watch a lease expire. Holding replay until the app is online is a rule of the playground; the core outbox
            does not check connectivity.
          </p>
          <h2>The rules to remember</h2>
          <ul>
            <li>A 2xx status removes the row. A 409 applies the conflict policy. Any other 4xx marks the row failed at once.</li>
            <li>
              A 5xx or a thrown error adds one to the retry count. The row goes back to pending until the count reaches
              <code> maxRetries</code> (default 3), then it is failed.
            </li>
            <li>
              There is no backoff delay and no connectivity check, and nothing in the core calls <code>replay</code> for you.
              Your application decides when to replay. <code>rateLimitMs</code> only spaces out sends inside one replay.
            </li>
            <li>
              A claim takes a lease with an owner and an expiry. An expired lease can be claimed by another worker, and the
              update that completes or fails a row is not fenced by the lease owner.
            </li>
            <li>
              In TypeScript the conflict policy and the rollback and merge callbacks are held in memory by the instance that
              enqueued the row, not stored in SQLite.
            </li>
          </ul>
          <Callout tone="warn" title="Dart and C#">
            The outbox lives on the SQLite adapter (<code>replayOutbox</code> and <code>ReplayOutboxAsync</code>). The retry
            limit is fixed at 3 and there are no rollback or merge callbacks. See the <a href="#/parity">parity matrix</a>.
          </Callout>
        </>
      }
    />
  );
}
