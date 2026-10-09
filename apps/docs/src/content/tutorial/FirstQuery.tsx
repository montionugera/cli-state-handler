import React from "react";
import { Callout, CodeBlock } from "../../components/Prose.js";
import { SwrPlayground } from "../../components/SwrPlayground.js";
import { TutorialPage } from "./TutorialPage.js";

export function FirstQuery() {
  return (
    <TutorialPage
      step={1}
      next={{ href: "#/tutorial-freshness", label: "Next: freshness and refetch timing" }}
      intro={
        <>
          <h1>Your First Query</h1>
          <p>
            A query is a key plus a function that fetches data. The query engine stores the result under the key, so a second
            read of the same key can be answered from the cache. In TypeScript you start one with <code>useQuery</code>, in
            Dart with <code>watchQuery</code> and in C# with <code>WatchQuery</code>.
          </p>
          <CodeBlock language="typescript">{`const engine = new QueryEngine({ defaultStaleTime: 5000 });
const profile = engine.useQuery(["users", "profile"], async () => ({ name: "Ada" }));
profile.subscribe(() => console.log(profile.getSnapshot().status));`}</CodeBlock>
        </>
      }
      visualiser={<SwrPlayground headingLevel="h2" />}
      after={
        <>
          <h2>What you will see</h2>
          <p>
            Press the fetch button in the playground. The first fetch is an initial load. A background refetch that returns the
            same payload keeps the existing object reference (structural sharing), so code that compares by reference does not
            see a change. The two panels under the playground show the lifecycle states and the stale and expiry timeline, which
            the next page walks through.
          </p>
          <h2>The rules to remember</h2>
          <ul>
            <li>
              <code>useQuery</code> with no data starts a fetch and reports <code>loading</code>. With stale data it keeps the
              cached data in the snapshot and revalidates in the background.
            </li>
            <li>
              <code>fetchQuery</code> is different: it returns the cached value only while the entry is fresh, otherwise it
              waits for a new fetch.
            </li>
            <li>
              The engine reports only loading, success and error. <code>LifecycleFSM</code> has no transition guards and the
              query engine does not use it, so treat the lifecycle graph as an illustration of the states.
            </li>
          </ul>
          <Callout tone="info" title="Platforms">
            Dart and C# have the same engine shape. The query function takes no context argument in Dart and a
            <code> CancellationToken</code> in C#. See the <a href="#/multiplatform">code reference</a>.
          </Callout>
        </>
      }
    />
  );
}
