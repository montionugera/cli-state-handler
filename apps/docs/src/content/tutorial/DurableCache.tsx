import React from "react";
import { Callout, CodeBlock } from "../../components/Prose.js";
import { WalVisualiser } from "../../components/WalVisualiser.js";
import { TutorialPage } from "./TutorialPage.js";

export function DurableCache() {
  return (
    <TutorialPage
      step={3}
      next={{ href: "#/tutorial-outbox", label: "Next: offline mutations with the outbox" }}
      intro={
        <>
          <h1>Durable Cache and WAL</h1>
          <p>
            Pass a <code>SqliteAdapter</code> to the engine and entries are saved to SQLite, so a restart starts warm. File
            databases use write-ahead logging (WAL): commits are appended to a separate log, and a checkpoint copies them back
            into the main file. <code>SqliteAdapter</code> needs Node (<code>better-sqlite3</code>); it is not in the browser build, which
            is why this page uses a simulation.
          </p>
          <CodeBlock language="typescript">{`const sqlite = new SqliteAdapter("./app.db");   // journalMode: WAL for files, MEMORY for ':memory:'
const engine = new QueryEngine({ sqliteAdapter: sqlite });
sqlite.checkpoint();                              // PRAGMA wal_checkpoint(TRUNCATE)`}</CodeBlock>
        </>
      }
      visualiser={<WalVisualiser headingLevel="h2" />}
      after={
        <>
          <h2>What you will see</h2>
          <p>
            The visualiser is a simulation, not a real SQLite engine. Write a few values and commit them to watch them land in
            the log, open a reader, then checkpoint to move the log back into the main file. Crash and Recover show what
            survives. The journal mode selector compares WAL with DELETE (rollback journal) mode.
          </p>
          <h2>The rules to remember</h2>
          <ul>
            <li>
              In TypeScript, <code>journalMode</code> defaults to WAL for file databases and MEMORY for <code>:memory:</code>.
              Dart and C# open file databases in WAL without an option.
            </li>
            <li>
              <code>checkpoint(mode = &quot;TRUNCATE&quot;)</code> runs <code>wal_checkpoint</code>. The TypeScript version falls
              back to PASSIVE if TRUNCATE finds the database busy; Dart and C# do not.
            </li>
            <li>
              Nothing in the core registers the exit flush for you. Call <code>registerExitFlush(() =&gt; sqlite.checkpoint())</code>
              yourself. In Unity, <code>UcsaBehaviour</code> checkpoints on pause and quit; Dart has no exit hook.
            </li>
          </ul>
          <Callout tone="info" title="Content store">
            Large blobs go in the content-addressed store (SHA-256, deduplicated). When it is over its byte budget it deletes
            least-recently-used blobs until it is at 70% of the budget. There is no reference counting or pinning, and a blob
            you just stored can be removed by its own prune. A budget of 0 means unbounded.
          </Callout>
        </>
      }
    />
  );
}
