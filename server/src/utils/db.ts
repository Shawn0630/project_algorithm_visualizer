import fs from 'fs';
import path from 'path';
import { rootDir } from 'config/paths';
import { createKey } from 'utils/hierarchy';

// SQLite store for everything the app serves and saves, in one file:
// server/data/visualizer.db (gitignored, on the Docker data volume).
//
//   problems       one row per problem; root is 'algorithm' (seeded
//                  from the bundled algorithms/ content) or 'leetcode'
//                  (created from the admin console, mostly by the
//                  LeetCode import flow). slug is createKey(title).
//   problem_files  the problem's files by name (README.md, code.py,
//                  tests.json, ...) - shared by every category the
//                  problem appears in.
//   problem_tags   categories are tags: a problem can sit in several
//                  categories at once. The statement/files are shared;
//                  only code sessions are per category.
//   pad_code       the user's per-pad code, keyed by
//                  "<categoryKey>/<algorithmKey>:<fileName>" (or
//                  "scratch:<gistId>:<fileName>") - the category is
//                  part of the key, so the same problem has an
//                  independent code session in each of its categories.
//   meta           bookkeeping (one-time migrations).
//
// better-sqlite3 is loaded lazily so a missing native build produces
// one clear boot error instead of a module-resolution stack.
let db: any;

export function getDb(): any {
  if (db) return db;
  let Database: any;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    throw new Error('better-sqlite3 could not be loaded - run "npm install" in server/ so the native SQLite module is installed for this machine.');
  }
  const dataDir = path.resolve(rootDir, 'data');
  fs.mkdirSync(dataDir, {recursive: true});
  db = new Database(path.resolve(dataDir, 'visualizer.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'import',
      difficulty TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_problems_root_slug ON problems(root, slug);
    CREATE TABLE IF NOT EXISTS problem_files (
      problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (problem_id, name)
    );
    CREATE TABLE IF NOT EXISTS problem_tags (
      problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (problem_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_problem_tags_tag ON problem_tags(tag);
    CREATE TABLE IF NOT EXISTS pad_code (
      pad_key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pad_tests (
      pad_key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Difficulty is problem metadata (a column), NOT a tag/category:
  // older databases carried it as an Easy/Medium/Hard problem_tags
  // row, which also made it show up as a category. Add the column
  // where missing, move any difficulty tags into it, then drop
  // those tag rows. Idempotent - after the first run there is
  // nothing left to move.
  const columns = db.prepare('PRAGMA table_info(problems)').all().map((row: any) => row.name);
  if (!columns.includes('difficulty')) {
    db.exec('ALTER TABLE problems ADD COLUMN difficulty TEXT');
  }
  db.exec(`
    UPDATE problems SET difficulty = (
      SELECT t.tag FROM problem_tags t
      WHERE t.problem_id = problems.id AND t.tag IN ('Easy', 'Medium', 'Hard')
      ORDER BY t.tag LIMIT 1
    ) WHERE difficulty IS NULL AND EXISTS (
      SELECT 1 FROM problem_tags t
      WHERE t.problem_id = problems.id AND t.tag IN ('Easy', 'Medium', 'Hard')
    );
    DELETE FROM problem_tags WHERE tag IN ('Easy', 'Medium', 'Hard');
  `);
  return db;
}

export interface ProblemRow {
  id: number;
  root: string;
  slug: string;
  title: string;
  source: string;
  difficulty: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProblemFile {
  name: string;
  content: string;
}

// Difficulty values live in problems.difficulty, never in
// problem_tags (a tag is a category; difficulty is metadata).
export const DIFFICULTY_VALUES = ['Easy', 'Medium', 'Hard'];

export function isDifficultyTag(tag: string): boolean {
  return DIFFICULTY_VALUES.includes(tag);
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function listProblems(root: string): ProblemRow[] {
  return getDb().prepare('SELECT * FROM problems WHERE root = ? ORDER BY title').all(root);
}

export function getProblem(id: number): ProblemRow | undefined {
  return getDb().prepare('SELECT * FROM problems WHERE id = ?').get(id);
}

export function findProblemBySlug(root: string, slug: string): ProblemRow | undefined {
  return getDb().prepare('SELECT * FROM problems WHERE root = ? AND slug = ? ORDER BY id LIMIT 1').get(root, slug);
}

export function listTags(root: string): string[] {
  const rows = getDb().prepare(
    'SELECT DISTINCT t.tag AS tag FROM problem_tags t JOIN problems p ON p.id = t.problem_id WHERE p.root = ? ORDER BY t.tag',
  ).all(root);
  return rows.map((row: any) => row.tag);
}

export function listProblemTags(problemId: number): string[] {
  const rows = getDb().prepare('SELECT tag FROM problem_tags WHERE problem_id = ? ORDER BY tag').all(problemId);
  return rows.map((row: any) => row.tag);
}

export function listProblemFiles(problemId: number): ProblemFile[] {
  return getDb().prepare('SELECT name, content FROM problem_files WHERE problem_id = ? ORDER BY name').all(problemId);
}

// Resolves the problem shown for (tag, title) inside a root - the
// admin console's content addressing. A problem appears once per tag,
// so the pair identifies a single row.
export function findProblem(root: string, tag: string, title: string): ProblemRow | undefined {
  return getDb().prepare(
    `SELECT p.* FROM problems p JOIN problem_tags t ON t.problem_id = p.id
     WHERE p.root = ? AND t.tag = ? AND p.title = ? ORDER BY p.id LIMIT 1`,
  ).get(root, tag, title);
}

export function createProblem(input: { root: string, title: string, source: string, tags: string[], files: ProblemFile[], difficulty?: string | null }): ProblemRow {
  const database = getDb();
  const now = Date.now();
  const slug = createKey(input.title);
  const insert = database.transaction(() => {
    const info = database.prepare('INSERT INTO problems (root, slug, title, source, difficulty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.root, slug, input.title, input.source, input.difficulty || null, now, now);
    const id = Number(info.lastInsertRowid);
    const fileStmt = database.prepare('INSERT INTO problem_files (problem_id, name, content) VALUES (?, ?, ?)');
    for (const file of input.files) fileStmt.run(id, file.name, file.content);
    const tagStmt = database.prepare('INSERT OR IGNORE INTO problem_tags (problem_id, tag) VALUES (?, ?)');
    for (const tag of input.tags) if (tag && tag.trim() && !isDifficultyTag(tag.trim())) tagStmt.run(id, tag.trim());
    return id;
  });
  const id = insert();
  return getProblem(id) as ProblemRow;
}

// Create or fully replace an imported problem, addressed by
// (root, slug): saving the same LeetCode problem twice updates it.
export function saveImportedProblem(input: { root: string, title: string, tags: string[], files: ProblemFile[], difficulty?: string | null }): ProblemRow {
  const database = getDb();
  const slug = createKey(input.title);
  const existing = findProblemBySlug(input.root, slug);
  const now = Date.now();
  const apply = database.transaction(() => {
    let id: number;
    if (existing) {
      id = existing.id;
      database.prepare('UPDATE problems SET title = ?, source = ?, difficulty = ?, updated_at = ? WHERE id = ?')
        .run(input.title, 'import', input.difficulty || null, now, id);
      database.prepare('DELETE FROM problem_files WHERE problem_id = ?').run(id);
      database.prepare('DELETE FROM problem_tags WHERE problem_id = ?').run(id);
    } else {
      const info = database.prepare('INSERT INTO problems (root, slug, title, source, difficulty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.root, slug, input.title, 'import', input.difficulty || null, now, now);
      id = Number(info.lastInsertRowid);
    }
    const fileStmt = database.prepare('INSERT INTO problem_files (problem_id, name, content) VALUES (?, ?, ?)');
    for (const file of input.files) fileStmt.run(id, file.name, file.content);
    const tagStmt = database.prepare('INSERT OR IGNORE INTO problem_tags (problem_id, tag) VALUES (?, ?)');
    for (const tag of input.tags) if (tag && tag.trim() && !isDifficultyTag(tag.trim())) tagStmt.run(id, tag.trim());
    return id;
  });
  return getProblem(apply()) as ProblemRow;
}

export function upsertProblemFile(problemId: number, name: string, content: string): void {
  const database = getDb();
  database.prepare('INSERT INTO problem_files (problem_id, name, content) VALUES (?, ?, ?) ON CONFLICT(problem_id, name) DO UPDATE SET content = excluded.content')
    .run(problemId, name, content);
  database.prepare('UPDATE problems SET updated_at = ? WHERE id = ?').run(Date.now(), problemId);
}

export function deleteProblemFile(problemId: number, name: string): void {
  getDb().prepare('DELETE FROM problem_files WHERE problem_id = ? AND name = ?').run(problemId, name);
}

export function addProblemTag(problemId: number, tag: string): void {
  if (tag && tag.trim() && !isDifficultyTag(tag.trim())) getDb().prepare('INSERT OR IGNORE INTO problem_tags (problem_id, tag) VALUES (?, ?)').run(problemId, tag.trim());
}

export function removeProblemTag(problemId: number, tag: string): void {
  getDb().prepare('DELETE FROM problem_tags WHERE problem_id = ? AND tag = ?').run(problemId, tag);
}

export function deleteProblem(problemId: number): void {
  getDb().prepare('DELETE FROM problems WHERE id = ?').run(problemId);
}

// [{category, algorithms: [{id, title, files: [names]}]}] for one
// root, in tag/title order - the shape the admin console renders and
// the hierarchy is built from.
export function contentTree(root: string): { category: string, algorithms: { id: number, title: string, slug: string, difficulty: string | null, files: string[] }[] }[] {
  const database = getDb();
  const rows = database.prepare(
    `SELECT t.tag AS tag, p.id AS id, p.title AS title, p.slug AS slug, p.difficulty AS difficulty
     FROM problems p JOIN problem_tags t ON t.problem_id = p.id
     WHERE p.root = ? ORDER BY t.tag, p.title`,
  ).all(root);
  const fileRows = database.prepare(
    `SELECT pf.problem_id AS problemId, pf.name AS name FROM problem_files pf
     JOIN problems p ON p.id = pf.problem_id WHERE p.root = ? ORDER BY pf.name`,
  ).all(root);
  const filesByProblem: { [id: number]: string[] } = {};
  for (const row of fileRows) {
    (filesByProblem[row.problemId] = filesByProblem[row.problemId] || []).push(row.name);
  }
  const tree: { category: string, algorithms: { id: number, title: string, slug: string, difficulty: string | null, files: string[] }[] }[] = [];
  for (const row of rows) {
    let category = tree.find(entry => entry.category === row.tag);
    if (!category) {
      category = {category: row.tag, algorithms: []};
      tree.push(category);
    }
    category.algorithms.push({id: row.id, title: row.title, slug: row.slug, difficulty: row.difficulty || null, files: filesByProblem[row.id] || []});
  }
  return tree;
}

// ---------- Seeding from the bundled algorithms/ content ----------

// Where the image/repo keeps the seed content: an explicit env var
// (Docker sets it), the server's bundled copy, or the repo-root
// algorithms/ folder next to server/.
export function seedAlgorithmsDir(): string | null {
  const candidates = [
    process.env.SEED_ALGORITHMS_DIR,
    path.resolve(rootDir, 'seed-content', 'algorithms'),
    path.resolve(rootDir, '..', 'algorithms'),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch (error) {
      // try the next candidate
    }
  }
  return null;
}

function importAlgorithmsFrom(dir: string): number {
  const database = getDb();
  let count = 0;
  const categories = (fs.readdirSync as any)(dir, {withFileTypes: true})
    .filter((entry: any) => entry.isDirectory() && !entry.name.startsWith('.'));
  const insertAll = database.transaction(() => {
    for (const category of categories) {
      const categoryPath = path.join(dir, category.name);
      const problemDirs = (fs.readdirSync as any)(categoryPath, {withFileTypes: true})
        .filter((entry: any) => entry.isDirectory() && !entry.name.startsWith('.'));
      for (const problemDir of problemDirs) {
        const problemPath = path.join(categoryPath, problemDir.name);
        const files: ProblemFile[] = [];
        for (const entry of (fs.readdirSync as any)(problemPath, {withFileTypes: true})) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue;
          const filePath = path.join(problemPath, entry.name);
          try {
            if (fs.statSync(filePath).size > MAX_FILE_BYTES) continue;
            files.push({name: entry.name, content: fs.readFileSync(filePath, 'utf8')});
          } catch (error) {
            // Unreadable/binary seed file: skip it, keep the rest.
          }
        }
        createProblem({root: 'algorithm', title: problemDir.name, source: 'seed', tags: [category.name], files});
        count += 1;
      }
    }
  });
  insertAll();
  return count;
}

// First boot: an empty problems table is filled from the bundled
// algorithms/ content, so a fresh install always has the full
// Algorithm section. Existing installs keep whatever the DB holds.
export function seedAlgorithmsIfEmpty(): number {
  const database = getDb();
  const row = database.prepare('SELECT COUNT(*) AS count FROM problems').get();
  if (row && row.count > 0) return 0;
  const dir = seedAlgorithmsDir();
  if (!dir) return 0;
  const count = importAlgorithmsFrom(dir);
  console.info(`Content: seeded ${count} algorithm problems from ${dir}`);
  return count;
}

// Admin "re-seed": replace every seed-sourced problem with the
// bundled content again (imported problems are untouched).
export function reseedAlgorithms(): number {
  const dir = seedAlgorithmsDir();
  if (!dir) throw new Error('No bundled algorithms/ content found to seed from.');
  getDb().prepare(`DELETE FROM problems WHERE source = 'seed'`).run();
  const count = importAlgorithmsFrom(dir);
  console.info(`Content: re-seeded ${count} algorithm problems from ${dir}`);
  return count;
}

// ---------- Per-pad code (was the file-based code cache) ----------

const MAX_PAD_ENTRIES = 500;

export function listPadCode(): { [key: string]: { content: string, ts: number } } {
  const rows = getDb().prepare('SELECT pad_key, content, updated_at FROM pad_code').all();
  const entries: { [key: string]: { content: string, ts: number } } = {};
  for (const row of rows) entries[row.pad_key] = {content: row.content, ts: row.updated_at};
  return entries;
}

export function putPadCode(key: string, content: string, ts?: number): void {
  const database = getDb();
  database.prepare('INSERT INTO pad_code (pad_key, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(pad_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at')
    .run(key, content, typeof ts === 'number' ? ts : Date.now());
  const row = database.prepare('SELECT COUNT(*) AS count FROM pad_code').get();
  if (row && row.count > MAX_PAD_ENTRIES) {
    database.prepare('DELETE FROM pad_code WHERE pad_key IN (SELECT pad_key FROM pad_code ORDER BY updated_at ASC LIMIT ?)')
      .run(row.count - MAX_PAD_ENTRIES);
  }
}

export function deletePadCode(key: string): void {
  getDb().prepare('DELETE FROM pad_code WHERE pad_key = ?').run(key);
}

// ---------- Per-pad test cases + test-case generation chat ----------
//
// One record per code pad (same pad keys as pad_code): the panel's
// entry + case list (in the panel's text form, so in-progress edits
// survive verbatim) and the dedicated test-case generation chat
// history for that pad. The browser keeps a localStorage copy as a
// hot cache and syncs with this store, so cases and chats follow
// the user across browsers and machines, and ride along with the
// database when it is moved (Docker volume included).

export interface PadTestRecord {
  entry: string,
  cases: any[],
  chat: any[],
  seededFrom: string | null,
  ts: number,
}

const PAD_TEST_DEFAULTS = {entry: '', cases: [] as any[], chat: [] as any[], seededFrom: null as string | null};

export function listPadTests(): { [key: string]: PadTestRecord } {
  const rows = getDb().prepare('SELECT pad_key, data, updated_at FROM pad_tests').all();
  const entries: { [key: string]: PadTestRecord } = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data);
      entries[row.pad_key] = {...PAD_TEST_DEFAULTS, ...parsed, ts: row.updated_at};
    } catch (error) {
      // A corrupt row is skipped rather than breaking the whole list.
    }
  }
  return entries;
}

export function putPadTests(key: string, patch: Partial<PadTestRecord>): PadTestRecord {
  const database = getDb();
  const row = database.prepare('SELECT data FROM pad_tests WHERE pad_key = ?').get(key);
  let current: any = {...PAD_TEST_DEFAULTS};
  if (row) {
    try {
      current = {...PAD_TEST_DEFAULTS, ...JSON.parse(row.data)};
    } catch (error) {
      // Start from defaults if the stored record is unreadable.
    }
  }
  const merged = {...current};
  if (typeof patch.entry === 'string') merged.entry = patch.entry;
  if (Array.isArray(patch.cases)) merged.cases = patch.cases;
  if (Array.isArray(patch.chat)) merged.chat = patch.chat;
  if (patch.seededFrom === null || typeof patch.seededFrom === 'string') merged.seededFrom = patch.seededFrom;
  const ts = Date.now();
  database.prepare('INSERT INTO pad_tests (pad_key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(pad_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(merged), ts);
  const count = database.prepare('SELECT COUNT(*) AS count FROM pad_tests').get();
  if (count && count.count > MAX_PAD_ENTRIES) {
    database.prepare('DELETE FROM pad_tests WHERE pad_key IN (SELECT pad_key FROM pad_tests ORDER BY updated_at ASC LIMIT ?)')
      .run(count.count - MAX_PAD_ENTRIES);
  }
  return {...merged, ts};
}

export function deletePadTests(key: string): void {
  getDb().prepare('DELETE FROM pad_tests WHERE pad_key = ?').run(key);
}

// One-time import of the old file-based cache (server/data/
// code-cache/manifest.json + one file per pad). The old directory is
// renamed aside, never deleted; a meta row makes this run only once.
export function migrateLegacyCodeCache(): void {
  const database = getDb();
  const done = database.prepare('SELECT value FROM meta WHERE key = ?').get('legacy_code_cache_migrated');
  if (done) return;
  database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('legacy_code_cache_migrated', '1');
  const cacheDir = path.resolve(rootDir, 'data', 'code-cache');
  const manifestPath = path.resolve(cacheDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let imported = 0;
    for (const key of Object.keys(manifest || {})) {
      const entry = manifest[key];
      if (!entry || typeof entry.file !== 'string') continue;
      const filePath = path.resolve(cacheDir, entry.file);
      if (!fs.existsSync(filePath)) continue;
      putPadCode(key, fs.readFileSync(filePath, 'utf8'), typeof entry.ts === 'number' ? entry.ts : undefined);
      imported += 1;
    }
    const aside = `${cacheDir}.migrated-${Date.now()}`;
    fs.renameSync(cacheDir, aside);
    console.info(`Code cache: imported ${imported} pad copies into the database; old files kept at ${path.basename(aside)}`);
  } catch (error) {
    console.error('Code cache: legacy import failed (files left in place):', (error as Error).message);
  }
}
