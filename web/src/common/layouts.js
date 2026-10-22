// Workspace layouts, designed around THIS app's panes rather than
// borrowed from another product. A layout is a snapshot the App
// can apply and restore:
//
//   mode 'strip' - the app's native horizontal strip of four
//     panes (Navigator, Visualization, Editor, AI Assistant) with
//     a visibles array + a weights array for ResizableContainer.
//   mode 'focus' - a 2x2 grid: left column = problem Markdown on
//     top, Visualization below; right column = code pad on top,
//     the Testcase panel below (starting collapsed). focus.cols
//     is the left/right split, focus.rows the left column's split.
//
// Built-ins: Default (strip, Navigator open, AI closed), Focus
// (the grid), AI (strip, Navigator closed, AI Assistant open on
// the right). The user can save the current arrangement under
// their own name. Everything persists in localStorage: the custom
// layouts and the last-used arrangement, restored on next load.
export const BUILTIN_LAYOUTS = [
  { name: 'Default', mode: 'strip', visibles: [true, true, true, false], weights: [1, 2, 2, 1.4] },
  { name: 'Focus', mode: 'focus', focus: { cols: [1, 1.15], rows: [1, 1] } },
  { name: 'AI', mode: 'strip', visibles: [false, true, true, true], weights: [1, 2.2, 2.6, 1.6] },
];

export const PANE_NAMES = ['Navigator', 'Visualization', 'Code', 'AI Assistant'];

const STORAGE_KEY = 'av-layouts-v1';

const isStrip = layout => Array.isArray(layout.visibles) && layout.visibles.length === 4
  && Array.isArray(layout.weights) && layout.weights.length === 4
  && layout.weights.every(w => typeof w === 'number' && w > 0);
const isFocus = layout => layout.focus
  && Array.isArray(layout.focus.cols) && layout.focus.cols.length === 2
  && Array.isArray(layout.focus.rows) && layout.focus.rows.length === 2
  && [...layout.focus.cols, ...layout.focus.rows].every(w => typeof w === 'number' && w > 0);

// Normalizes a stored/built-in layout to the snapshot shape
// (older saves have no mode and are strip layouts). Returns null
// for anything unusable.
export function normalizeLayout(layout) {
  if (!layout || typeof layout.name !== 'string' || !layout.name.trim()) return null;
  if (layout.mode === 'focus' || (!layout.mode && isFocus(layout))) {
    return isFocus(layout) ? { name: layout.name, mode: 'focus', focus: { cols: [...layout.focus.cols], rows: [...layout.focus.rows] } } : null;
  }
  return isStrip(layout) ? { name: layout.name, mode: 'strip', visibles: [...layout.visibles], weights: [...layout.weights] } : null;
}

export function loadLayoutStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { custom: [], current: null };
    return {
      custom: Array.isArray(parsed.custom) ? parsed.custom.map(normalizeLayout).filter(Boolean) : [],
      current: normalizeLayout(parsed.current),
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

const close = (a, b) => Math.abs(a - b) < 0.05;

// Whether two snapshots describe the same arrangement (weights
// compared loosely - the resizer nudges them by tiny amounts).
export function sameLayout(a, b) {
  const x = normalizeLayout(a);
  const y = normalizeLayout(b);
  if (!x || !y || x.mode !== y.mode) return false;
  if (x.mode === 'focus') {
    return x.focus.cols.every((w, i) => close(w, y.focus.cols[i]))
      && x.focus.rows.every((w, i) => close(w, y.focus.rows[i]));
  }
  return x.visibles.every((v, i) => v === y.visibles[i])
    && x.weights.every((w, i) => close(w, y.weights[i]));
}
