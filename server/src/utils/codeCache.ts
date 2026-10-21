import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { rootDir } from 'config/paths';

// Server-side cache of the user's per-pad code, one file per pad
// under server/data/code-cache/ plus a manifest.json mapping pad
// keys ("<categoryKey>/<algorithmKey>:<fileName>", or
// "scratch:<gistId>:<fileName>") to files. The web app keeps the
// same copies in localStorage as a hot cache and syncs both ways
// by timestamp, so the user's code for each problem survives
// browser clears and browser switches. server/data/ is gitignored
// and outside the content working copies, so neither git pulls nor
// the LAN content re-pulls touch it. Local/intranet use only, like
// the rest of this server's data.
const cacheDir = path.resolve(rootDir, 'data', 'code-cache');
const manifestPath = path.resolve(cacheDir, 'manifest.json');
const MAX_ENTRIES = 500;

interface ManifestEntry { file: string, ts: number }
type Manifest = { [key: string]: ManifestEntry };

async function readManifest(): Promise<Manifest> {
  try {
    const parsed = await fs.readJson(manifestPath);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await fs.ensureDir(cacheDir);
  const tmp = `${manifestPath}.tmp`;
  await fs.writeJson(tmp, manifest);
  await fs.rename(tmp, manifestPath);
}

function fileNameFor(key: string): string {
  const readable = key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  return `${readable}.${hash}.code`;
}

export async function listCodeCache(): Promise<{ [key: string]: { content: string, ts: number } }> {
  const manifest = await readManifest();
  const entries: { [key: string]: { content: string, ts: number } } = {};
  for (const key of Object.keys(manifest)) {
    try {
      entries[key] = {
        content: await fs.readFile(path.resolve(cacheDir, manifest[key].file), 'utf8'),
        ts: manifest[key].ts,
      };
    } catch (error) {
      // File gone: skip the entry (the manifest heals on next write).
    }
  }
  return entries;
}

export async function putCodeCache(key: string, content: string, ts?: number): Promise<void> {
  await fs.ensureDir(cacheDir);
  const manifest = await readManifest();
  const file = (manifest[key] && manifest[key].file) || fileNameFor(key);
  await fs.writeFile(path.resolve(cacheDir, file), content);
  manifest[key] = { file, ts: typeof ts === 'number' ? ts : Date.now() };
  const keys = Object.keys(manifest);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => manifest[a].ts - manifest[b].ts);
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      await fs.remove(path.resolve(cacheDir, manifest[stale].file)).catch(() => undefined);
      delete manifest[stale];
    }
  }
  await writeManifest(manifest);
}

export async function deleteCodeCache(key: string): Promise<void> {
  const manifest = await readManifest();
  if (!manifest[key]) return;
  await fs.remove(path.resolve(cacheDir, manifest[key].file)).catch(() => undefined);
  delete manifest[key];
  await writeManifest(manifest);
}
