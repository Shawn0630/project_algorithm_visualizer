import { aiPadKey } from 'common/util';
import { CodeCacheApi } from 'apis';

// Per-pad local copies of the user's code - the same pattern as the
// AI sessions and the test cases. Algorithm and LeetCode pages ship
// read-only content, so without this every edit would vanish on the
// next page load. When a page loads, a pad's copy (if any) replaces
// the shipped content; every edit is written back; editing back to
// the shipped text, deleting the file, or using "Restore original"
// in the editor footer drops the copy. The shipped ("original")
// content is remembered in memory only, per page load. Copies are
// keyed by page + file name via aiPadKey, so each problem's pads
// keep their own code.
//
// Two tiers: localStorage is the hot cache (synchronous, so page
// loads can overlay immediately), and the server keeps the durable
// copy in server/data/code-cache/ (one file per pad). hydrateCodeCache
// merges the server tier in at startup - newer timestamp wins - and
// edits sync back up (typing is debounced, structural changes go
// immediately). If the server is unreachable everything still works
// from localStorage alone.
//
// Files the user ADDS to a page (the pad's + button) are not part
// of the shipped problem, so the shipped file list alone would
// never bring them back after a reload. Their names are kept in a
// per-page list entry in the same store (same sync), and
// overlaySavedCode re-creates them on load from their code copy.
const STORAGE_KEY = 'av-code-v1';
const MAX_BYTES = 4000000;
const originals = {};

let memory = null;
const dirty = new Set();
const deleted = new Set();
let syncTimer = null;

function loadAll() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function store() {
  if (!memory) memory = loadAll();
  return memory;
}

function flushLocal() {
  try {
    let data = store();
    if (JSON.stringify(data).length > MAX_BYTES) {
      // Prune the oldest copies first.
      data = {};
      Object.keys(store()).sort((a, b) => (store()[a].ts || 0) - (store()[b].ts || 0))
        .forEach(key => {
          if (JSON.stringify(data).length > MAX_BYTES * 0.75) return;
          data[key] = store()[key];
        });
      memory = data;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    // Storage full or unavailable: edits simply stay in memory.
  }
}

function syncNow() {
  const puts = [...dirty];
  const removals = [...deleted];
  dirty.clear();
  deleted.clear();
  puts.forEach(key => {
    const entry = store()[key];
    // The pad may have been dropped again while the debounce ran.
    if (entry) CodeCacheApi.put({ key, content: entry.content, ts: entry.ts }).catch(() => undefined);
  });
  removals.forEach(key => {
    CodeCacheApi.remove({ key }).catch(() => undefined);
  });
}

function scheduleSync(immediate = false) {
  flushLocal();
  if (immediate) {
    if (syncTimer) {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    syncNow();
    return;
  }
  if (syncTimer) return;
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    syncNow();
  }, 800);
}

function markPut(key) {
  deleted.delete(key);
  dirty.add(key);
  scheduleSync(false);
}

function markDelete(key) {
  dirty.delete(key);
  deleted.add(key);
  scheduleSync(true);
}

// Merges the server tier into the local store once, at startup.
// Resolves quickly even if the server is slow or down - the app
// must never wait on this to load a page.
let hydratePromise = null;
export function hydrateCodeCache() {
  if (hydratePromise) return hydratePromise;
  const merge = CodeCacheApi.list().then(({ entries }) => {
    if (!entries || typeof entries !== 'object') return;
    const local = store();
    Object.keys(entries).forEach(key => {
      const remote = entries[key];
      if (!remote || typeof remote.content !== 'string') return;
      if (!local[key] || (remote.ts || 0) >= (local[key].ts || 0)) {
        local[key] = { content: remote.content, ts: remote.ts || 0 };
      }
    });
    flushLocal();
  }).catch(() => undefined);
  const timeout = new Promise(resolve => window.setTimeout(resolve, 1500));
  hydratePromise = Promise.race([merge, timeout]);
  return hydratePromise;
}

// --- User-added files -------------------------------------------------
// The list entry's key cannot collide with a pad key: pad keys are
// "<page>:<fileName>", this one is "<page>|files".

function userFilesKey(identity) {
  return `${aiPadKey(identity, '')}|files`;
}

function readUserFiles(identity) {
  const entry = store()[userFilesKey(identity)];
  if (!entry || typeof entry.content !== 'string') return [];
  try {
    const names = JSON.parse(entry.content);
    return Array.isArray(names) ? names.filter(name => typeof name === 'string') : [];
  } catch (error) {
    return [];
  }
}

function writeUserFiles(identity, names) {
  const key = userFilesKey(identity);
  const all = store();
  if (names.length === 0) {
    if (all[key]) {
      delete all[key];
      markDelete(key);
    } else {
      flushLocal();
    }
    return;
  }
  all[key] = { content: JSON.stringify(names), ts: Date.now() };
  markPut(key);
}

export function noteUserFile(identity, fileName) {
  const names = readUserFiles(identity);
  if (!names.includes(fileName)) writeUserFiles(identity, [...names, fileName]);
}

export function forgetUserFile(identity, fileName) {
  const names = readUserFiles(identity);
  if (names.includes(fileName)) writeUserFiles(identity, names.filter(name => name !== fileName));
}

function moveUserFile(identity, oldName, newName) {
  const names = readUserFiles(identity);
  if (names.includes(oldName)) {
    writeUserFiles(identity, names.map(name => (name === oldName ? newName : name)));
  }
}

// Maps a page's loaded files to their local copies where they
// exist, and records the shipped contents as the originals. Files
// the user added to the page are re-created at the end: they are
// not in the shipped list, and their body is their code copy
// (empty only if the copy is somehow gone).
export function overlaySavedCode(identity, files) {
  const all = store();
  const overlaid = files.map(file => {
    const key = aiPadKey(identity, file.name);
    originals[key] = file.content;
    const saved = all[key];
    return saved && typeof saved.content === 'string' && saved.content !== file.content
      ? { ...file, content: saved.content }
      : file;
  });
  const present = new Set(overlaid.map(file => file.name));
  const restored = readUserFiles(identity)
    .filter(name => !present.has(name))
    .map(name => {
      const saved = all[aiPadKey(identity, name)];
      return { name, content: saved && typeof saved.content === 'string' ? saved.content : '' };
    });
  return [...overlaid, ...restored];
}

export function persistCode(identity, fileName, content) {
  const key = aiPadKey(identity, fileName);
  const all = store();
  if (originals[key] !== undefined && originals[key] === content) {
    // Back to the shipped text: no copy needed anymore.
    if (all[key]) {
      delete all[key];
      markDelete(key);
    }
    return;
  }
  all[key] = { content, ts: Date.now() };
  markPut(key);
}

export function dropSavedCode(identity, fileName) {
  const key = aiPadKey(identity, fileName);
  const all = store();
  if (all[key]) {
    delete all[key];
    markDelete(key);
  } else {
    flushLocal();
  }
  delete originals[key];
}

export function moveSavedCode(identity, oldName, newName) {
  const oldKey = aiPadKey(identity, oldName);
  const newKey = aiPadKey(identity, newName);
  const all = store();
  if (all[oldKey]) {
    all[newKey] = all[oldKey];
    delete all[oldKey];
    dirty.delete(oldKey);
    deleted.add(oldKey);
    dirty.add(newKey);
    deleted.delete(newKey);
    scheduleSync(true);
  }
  if (originals[oldKey] !== undefined) {
    originals[newKey] = originals[oldKey];
    delete originals[oldKey];
  }
  moveUserFile(identity, oldName, newName);
}

// A language-template replacement installs a fresh skeleton under
// (possibly) a new name: any local copy for either name goes, and
// the skeleton becomes the "original" for the pad. For a
// user-added file the membership moves with it, the skeleton is
// seeded as its code copy, and no "original" is kept - a user
// file has no shipped text to restore to, and an original would
// let a later edit-back drop the only copy of its content.
export function resetSavedCode(identity, oldName, newName, templateContent) {
  dropSavedCode(identity, oldName);
  if (newName !== oldName) dropSavedCode(identity, newName);
  moveUserFile(identity, oldName, newName);
  if (readUserFiles(identity).includes(newName)) {
    const key = aiPadKey(identity, newName);
    store()[key] = { content: templateContent, ts: Date.now() };
    markPut(key);
    delete originals[key];
  } else {
    originals[aiPadKey(identity, newName)] = templateContent;
  }
}

export function hasLocalCopy(identity, fileName) {
  const key = aiPadKey(identity, fileName);
  const all = store();
  return !!all[key] && originals[key] !== undefined && all[key].content !== originals[key];
}

export function originalContent(identity, fileName) {
  return originals[aiPadKey(identity, fileName)];
}
