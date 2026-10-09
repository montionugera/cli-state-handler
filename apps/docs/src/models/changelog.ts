export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}

/** Parses the repo-root CHANGELOG.md (written by scripts/release) into entries, newest first. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const line of text.split("\n")) {
    const heading = /^## (\S+)(?: - (\S+))?$/.exec(line.trim());
    if (heading) {
      entries.push({ version: heading[1], date: heading[2] ?? "", notes: [] });
      continue;
    }
    const bullet = /^- (.+)$/.exec(line.trim());
    if (bullet && entries.length > 0) entries[entries.length - 1].notes.push(bullet[1]);
  }
  return entries;
}
