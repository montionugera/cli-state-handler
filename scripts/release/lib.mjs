// Pure release-decision logic. No I/O: next-release.mjs feeds it.
const PLANNED = /^release (\d+\.\d+)(?: \(#\d+\))?$/;
const CONVENTIONAL = /^(?:\*\s+)?([a-z]+)(?:\([^)]*\))?(!)?:\s+(.+?)(?:\s+\(#\d+\))?$/;
const RELEASING = { feat: 'minor', fix: 'patch', perf: 'patch' };
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function bump(version, level) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`cannot bump non-numeric version: ${version}`);
  if (!['major', 'minor', 'patch'].includes(level)) throw new Error(`unknown bump level: ${level}`);
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump level: ${level}`);
}

export function notesForCommit({ subject, body }, catalog) {
  const planned = PLANNED.exec(subject.trim());
  if (planned) {
    const features = catalog.filter((f) => f.release_version === planned[1]);
    if (features.length === 0) return { level: 'patch', notes: [`Maintenance release ${planned[1]}`] };
    return { level: 'minor', notes: features.map((f) => `${f.title} (${f.id})`) };
  }
  let level = 'none';
  const notes = [];
  for (const line of [subject, ...body.split('\n')]) {
    const m = CONVENTIONAL.exec(line.trim());
    if (!m) continue;
    const [, type, bang, text] = m;
    const lineLevel = bang ? 'major' : (RELEASING[type] ?? 'none');
    if (lineLevel === 'none') continue;
    const note = `${type}: ${text}`;
    if (!notes.includes(note)) notes.push(note);
    if (RANK[lineLevel] > RANK[level]) level = lineLevel;
  }
  if (notes.length > 0 && /^BREAKING CHANGE:/m.test(body)) level = 'major';
  return { level, notes };
}

export function decide({ currentVersion, commits, catalog, currentIsTagged, currentIsPublished }) {
  if (currentIsTagged && !currentIsPublished) return { action: 'publish-only', version: currentVersion, notes: [] };
  let level = 'none';
  const notes = [];
  // git log lists newest first; notes read better oldest first.
  for (const commit of [...commits].reverse()) {
    const r = notesForCommit(commit, catalog);
    if (RANK[r.level] > RANK[level]) level = r.level;
    for (const note of r.notes) if (!notes.includes(note)) notes.push(note);
  }
  if (level === 'none') return { action: 'none', version: currentVersion, notes: [] };
  return { action: 'release', version: bump(currentVersion, level), notes };
}

export function changelogEntry(version, date, notes) {
  return `## ${version} - ${date}\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`;
}

export function prependEntry(existing, entry) {
  const i = existing.indexOf('\n## ');
  if (i === -1) return `${existing.trimEnd()}\n\n${entry}`;
  return `${existing.slice(0, i + 1)}${entry}\n${existing.slice(i + 1)}`;
}

export function extractEntry(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
