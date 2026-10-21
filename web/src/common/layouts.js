// Workspace layout presets: the workspace is four panes
// (Navigator, Visualization, Editor, AI Assistant) arranged by
// ResizableContainer from a visibles array + a weights array, so a
// layout is exactly {visibles, weights}. Built-in presets mirror
// the LeetCode layout picker's set; the user can also save the
// current arrangement under their own name. Everything persists
// in localStorage: the custom layouts and the last-used
// arrangement (restored on the next load).
export const BUILTIN_LAYOUTS = [
  { name: 'Default', visibles: [true, true, true, false], weights: [1, 2, 2, 1.4] },
  { name: 'Leet', visibles: [false, true, true, false], weights: [1, 5, 4, 1.4] },
  { name: 'Note-taking', visibles: [true, true, true, false], weights: [1, 3.4, 1.6, 1.4] },
  { name: 'Debug', visibles: [false, true, true, true], weights: [1, 2.2, 2.6, 1.6] },
  { name: 'Focus', visibles: [false, true, true, false], weights: [1, 1, 1, 1.4] },
];

export const PANE_NAMES = ['Navigator', 'Visualization', 'Code', 'AI Assistant'];

const STORAGE_KEY = 'av-layouts-v1';

function validLayout(layout) {
  return layout && typeof layout.name === 'string' && layout.name.trim()
    && Array.isArray(layout.visibles) && layout.visibles.length === 4
    && Array.isArray(layout.weights) && layout.weights.length === 4
    && layout.weights.every(w => typeof w === 'number' && w > 0);
}

export function loadLayoutStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { custom: [], current: null };
    return {
      custom: Array.isArray(parsed.custom) ? parsed.custom.filter(validLayout) : [],
      current: validLayout(parsed.current) ? parsed.current : null,
    };
  } catch (error) {
    return { custom: [], current: null };
  }
}

export function saveLayoutStore(store) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    // Storage unavailable: layouts simply do not persist.
  }
}

// Whether two arrangements are the same layout (weights compared
// loosely - the resizer nudges them by tiny amounts).
export function sameLayout(a, b) {
  if (!a || !b) return false;
  return a.visibles.every((v, i) => v === b.visibles[i])
    && a.weights.every((w, i) => Math.abs(w - b.weights[i]) < 0.05);
}
