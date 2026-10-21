import { aiPadKey } from 'common/util';

// Per-pad local copies of the user's code, in localStorage - the
// same pattern as the AI sessions and the test cases. Algorithm and
// LeetCode pages ship read-only content, so without this every edit
// would vanish on the next page load. When a page loads, a pad's
// local copy (if any) replaces the shipped content; every edit is
// written back here; editing back to the shipped text, deleting
// the file, or using "Restore original" in the editor footer drops
// the copy. The shipped ("original") content is remembered in
// memory only, per page load. Copies are keyed by page + file name
// via aiPadKey, so each problem's pads keep their own code.
// This is per-browser storage: it does not sync to the server or
// the repo.
const STORAGE_KEY = 'av-code-v1';
const MAX_BYTES = 4000000;
const originals = {};

function loadAll() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveAll(map) {
  try {
    let data = map;
    if (JSON.stringify(data).length > MAX_BYTES) {
      // Prune the oldest copies first.
      data = {};
      Object.keys(map).sort((a, b) => (map[a].ts || 0) - (map[b].ts || 0))
        .forEach(key => {
          if (JSON.stringify(data).length > MAX_BYTES * 0.75) return;
          data[key] = map[key];
        });
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    // Storage full or unavailable: edits simply stay in memory.
  }
}

// Maps a page's loaded files to their local copies where they
// exist, and records the shipped contents as the originals.
export function overlaySavedCode(identity, files) {
  const all = loadAll();
  return files.map(file => {
    const key = aiPadKey(identity, file.name);
    originals[key] = file.content;
    const saved = all[key];
    return saved && typeof saved.content === 'string' && saved.content !== file.content
      ? { ...file, content: saved.content }
      : file;
  });
}

export function persistCode(identity, fileName, content) {
  const key = aiPadKey(identity, fileName);
  const all = loadAll();
  if (originals[key] !== undefined && originals[key] === content) {
    // Back to the shipped text: no copy needed anymore.
    if (all[key]) {
      delete all[key];
      saveAll(all);
    }
    return;
  }
  all[key] = { content, ts: Date.now() };
  saveAll(all);
}

export function dropSavedCode(identity, fileName) {
  const key = aiPadKey(identity, fileName);
  const all = loadAll();
  if (all[key]) {
    delete all[key];
    saveAll(all);
  }
  delete originals[key];
}

export function moveSavedCode(identity, oldName, newName) {
  const oldKey = aiPadKey(identity, oldName);
  const newKey = aiPadKey(identity, newName);
  const all = loadAll();
  if (all[oldKey]) {
    all[newKey] = all[oldKey];
    delete all[oldKey];
    saveAll(all);
  }
  if (originals[oldKey] !== undefined) {
    originals[newKey] = originals[oldKey];
    delete originals[oldKey];
  }
}

// A language-template replacement installs a fresh skeleton under
// (possibly) a new name: any local copy for either name goes, and
// the skeleton becomes the "original" for the pad.
export function resetSavedCode(identity, oldName, newName, templateContent) {
  dropSavedCode(identity, oldName);
  if (newName !== oldName) dropSavedCode(identity, newName);
  originals[aiPadKey(identity, newName)] = templateContent;
}

export function hasLocalCopy(identity, fileName) {
  const key = aiPadKey(identity, fileName);
  const all = loadAll();
  return !!all[key] && originals[key] !== undefined && all[key].content !== originals[key];
}

export function originalContent(identity, fileName) {
  return originals[aiPadKey(identity, fileName)];
}
