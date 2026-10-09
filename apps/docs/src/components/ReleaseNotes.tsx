import changelog from "../../../../CHANGELOG.md?raw";
import { parseChangelog } from "../models/changelog.js";
import { Prose } from "./Prose.js";

const entries = parseChangelog(changelog);

export function ReleaseNotes() {
  return (
    <Prose>
      <h1>Release notes</h1>
      <p>
        Every version of <code>@montionugera/ucsa-core</code> and <code>@montionugera/ucsa-cli</code>. Both packages
        always share one version.
      </p>
      {entries.map((entry) => (
        <section key={entry.version}>
          <h2>
            {entry.version}
            {entry.date ? ` (${entry.date})` : ""}
          </h2>
          <ul>
            {entry.notes.map((note, i) => (
              <li key={`${i}-${note}`}>{note}</li>
            ))}
          </ul>
        </section>
      ))}
    </Prose>
  );
}
