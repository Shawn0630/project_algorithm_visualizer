import { deletePadCode, listPadCode, migrateLegacyCodeCache, putPadCode } from 'utils/db';

// Server-side store of the user's per-pad code, in the SQLite
// database (utils/db, table pad_code) keyed by pad key
// ("<categoryKey>/<algorithmKey>:<fileName>", or
// "scratch:<gistId>:<fileName>"). The web app keeps the same copies
// in localStorage as a hot cache and syncs both ways by timestamp,
// so the user's code for each problem survives browser clears and
// browser switches. Writes are single-row upserts in a transaction
// - no manifest read-modify-write, so concurrent saves cannot
// clobber each other. The old file-based cache (one file per pad
// under server/data/code-cache/) is imported once by
// migrateLegacyCodeCache and renamed aside.
export async function listCodeCache(): Promise<{ [key: string]: { content: string, ts: number } }> {
  migrateLegacyCodeCache();
  return listPadCode();
}

export async function putCodeCache(key: string, content: string, ts?: number): Promise<void> {
  migrateLegacyCodeCache();
  putPadCode(key, content, ts);
}

export async function deleteCodeCache(key: string): Promise<void> {
  migrateLegacyCodeCache();
  deletePadCode(key);
}
