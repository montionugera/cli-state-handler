import type Database from 'better-sqlite3';

interface TagIndexStatements {
  insertTag: Database.Statement<[string, string]>;
  getHashesByTag: Database.Statement<[string]>;
  deleteByQueryHash: Database.Statement<[string]>;
}

const statementCache = new WeakMap<Database.Database, TagIndexStatements>();

function getStatements(db: Database.Database): TagIndexStatements {
  let stmts = statementCache.get(db);
  if (!stmts) {
    stmts = {
      insertTag: db.prepare<[string, string]>(
        'INSERT OR IGNORE INTO ucsa_cache_tags (tag, query_hash) VALUES (?, ?)'
      ),
      getHashesByTag: db.prepare<[string]>(
        'SELECT query_hash FROM ucsa_cache_tags WHERE tag = ?'
      ),
      deleteByQueryHash: db.prepare<[string]>(
        'DELETE FROM ucsa_cache_tags WHERE query_hash = ?'
      ),
    };
    statementCache.set(db, stmts);
  }
  return stmts;
}

/**
 * Inserts one or more tag associations for a given query hash.
 * Duplicate (tag, query_hash) pairs are ignored.
 */
export function insertTags(
  db: Database.Database,
  queryHash: string,
  tags: readonly string[]
): void {
  if (tags.length === 0) return;

  const { insertTag } = getStatements(db);

  if (tags.length === 1) {
    insertTag.run(tags[0], queryHash);
    return;
  }

  const insertMany = db.transaction((hashes: string, tagList: readonly string[]) => {
    for (const tag of tagList) {
      insertTag.run(tag, hashes);
    }
  });

  insertMany(queryHash, tags);
}

/**
 * Returns all query hashes associated with a given tag.
 */
export function getQueryHashesByTag(db: Database.Database, tag: string): string[] {
  const { getHashesByTag } = getStatements(db);
  const rows = getHashesByTag.all(tag) as Array<{ query_hash: string }>;
  return rows.map((r) => r.query_hash);
}

/**
 * Removes all tag records associated with a specific query hash.
 */
export function deleteTagsForQuery(db: Database.Database, queryHash: string): void {
  const { deleteByQueryHash } = getStatements(db);
  deleteByQueryHash.run(queryHash);
}
