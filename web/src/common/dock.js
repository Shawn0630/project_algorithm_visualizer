// Docking layout: the workspace is a tree of panels the user
// rearranges by dragging, the way LeetCode / VS Code docks work.
//
//   node = { kind: 'split', id, dir: 'row' | 'col',
//            weights: [number...], children: [node...] }
//        | { kind: 'leaf', id, panels: [panelId...], active: panelId }
//
// A leaf holding several panels shows them as tabs; dropping a
// dragged panel on a leaf's center joins its tabs, dropping on
// an edge splits the leaf. Splits render through the existing
// ResizableContainer, so every divider stays draggable and the
// weights live right in the tree.
//
// Panels: navigator, doc (problem Markdown), viz (the player),
// code (the code pad), tests (the Testcase panel), ai (the AI
// Assistant). A panel lives in at most one leaf; panels absent
// from the tree are closed and can be reopened from the header
// toggles or the Layouts menu's Panels checklist.
//
// Everything persists in localStorage under av-dock-v1. The old
// av-layouts-v1 store (strip/focus snapshots) is migrated once,
// on first load, so an existing arrangement carries over.
import { loadLayoutStore } from 'common/layouts';

export const PANELS = [
  { id: 'navigator', title: 'Navigator' },
  { id: 'doc', title: 'Description' },
  { id: 'viz', title: 'Visualization' },
  { id: 'code', title: 'Code' },
  { id: 'tests', title: 'Testcase' },
  { id: 'ai', title: 'AI Assistant' },
];
export const PANEL_IDS = PANELS.map(panel => panel.id);
export const panelTitle = id => (PANELS.find(panel => panel.id === id) || {}).title || id;

const STORAGE_KEY = 'av-dock-v1';

let idCounter = 0;
const nextId = prefix => `${prefix}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function makeLeaf(panels, active) {
  return {
    kind: 'leaf',
    id: nextId('leaf'),
    panels: [...panels],
    active: active && panels.includes(active) ? active : panels[0],
  };
}

export function makeSplit(dir, weights, children) {
  return { kind: 'split', id: nextId('split'), dir, weights: [...weights], children };
}

export function presetTree(name) {
  if (name === 'Focus') {
    return makeSplit('row', [1.15, 1], [
      makeSplit('col', [1, 1], [makeLeaf(['doc']), makeLeaf(['viz'])]),
      makeSplit('col', [2.6, 1], [makeLeaf(['code']), makeLeaf(['tests'])]),
    ]);
  }
  if (name === 'AI') {
    return makeSplit('row', [2.1, 2.9, 1.6], [
      makeLeaf(['doc', 'viz'], 'doc'),
      makeSplit('col', [2.7, 1], [makeLeaf(['code']), makeLeaf(['tests'])]),
      makeLeaf(['ai']),
    ]);
  }
  // Default: Navigator | Description/Visualization tabs |
  // Code over Testcase.
  return makeSplit('row', [1, 2.1, 2.9], [
    makeLeaf(['navigator']),
    makeLeaf(['doc', 'viz'], 'doc'),
    makeSplit('col', [2.7, 1], [makeLeaf(['code']), makeLeaf(['tests'])]),
  ]);
}

export const BUILTIN_PRESETS = [
  { name: 'Default', description: 'Navigator, statement and code side by side' },
  { name: 'Focus', description: '2x2: statement and visualization left, code and tests right' },
  { name: 'AI', description: 'Default plus the AI Assistant on the right' },
];

// --- tree queries -------------------------------------------------

export function treePanels(tree, into = new Set()) {
  if (!tree) return into;
  if (tree.kind === 'leaf') tree.panels.forEach(id => into.add(id));
  else tree.children.forEach(child => treePanels(child, into));
  return into;
}

export function findLeafById(tree, leafId) {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.id === leafId ? tree : null;
  for (const child of tree.children) {
    const found = findLeafById(child, leafId);
    if (found) return found;
  }
  return null;
}

export function findLeafByPanel(tree, panelId) {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree.panels.includes(panelId) ? tree : null;
  for (const child of tree.children) {
    const found = findLeafByPanel(child, panelId);
    if (found) return found;
  }
  return null;
}

const clone = tree => (tree ? JSON.parse(JSON.stringify(tree)) : null);

// --- validation ---------------------------------------------------

// Repairs a parsed tree: unknown/duplicate panels dropped, every
// leaf's active panel valid, weights positive and matching the
// children. Returns null when nothing usable remains.
export function normalizeTree(input, seen = new Set()) {
  if (!input || typeof input !== 'object') return null;
  if (input.kind === 'leaf') {
    const panels = (Array.isArray(input.panels) ? input.panels : [])
      .filter(id => PANEL_IDS.includes(id) && !seen.has(id));
    panels.forEach(id => seen.add(id));
    if (!panels.length) return null;
    return {
      kind: 'leaf',
      id: typeof input.id === 'string' ? input.id : nextId('leaf'),
      panels,
      active: panels.includes(input.active) ? input.active : panels[0],
    };
  }
  if (input.kind === 'split') {
    const rawChildren = Array.isArray(input.children) ? input.children : [];
    const children = [];
    const weights = [];
    rawChildren.forEach((child, i) => {
      const normalized = normalizeTree(child, seen);
      if (normalized) {
        children.push(normalized);
        const w = Array.isArray(input.weights) ? input.weights[i] : null;
        weights.push(typeof w === 'number' && w > 0 ? w : 1);
      }
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    return {
      kind: 'split',
      id: typeof input.id === 'string' ? input.id : nextId('split'),
      dir: input.dir === 'col' ? 'col' : 'row',
      weights,
      children,
    };
  }
  return null;
}

// --- edits (all return a new tree) --------------------------------

export function updateWeights(tree, splitId, weights) {
  const next = clone(tree);
  const walk = node => {
    if (!node || node.kind !== 'split') return false;
    if (node.id === splitId) {
      node.weights = [...weights];
      return true;
    }
    return node.children.some(walk);
  };
  walk(next);
  return next;
}

export function setActivePanel(tree, panelId) {
  const next = clone(tree);
  const leaf = findLeafByPanel(next, panelId);
  if (leaf) leaf.active = panelId;
  return next;
}

export function setLeafActive(tree, leafId, panelId) {
  const next = clone(tree);
  const leaf = findLeafById(next, leafId);
  if (leaf && leaf.panels.includes(panelId)) leaf.active = panelId;
  return next;
}

// Removes a node from its parent split, then prunes: empty
// leaves vanish, a split left with one child is replaced by it.
// Children stay paired with their weights throughout.
function pruneSplit(node) {
  if (!node) return null;
  if (node.kind === 'leaf') return node.panels.length ? node : null;
  const kept = [];
  node.children.forEach((child, i) => {
    const pruned = pruneSplit(child);
    if (pruned) kept.push({ child: pruned, weight: node.weights[i] });
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0].child;
  node.children = kept.map(entry => entry.child);
  node.weights = kept.map(entry => (typeof entry.weight === 'number' && entry.weight > 0 ? entry.weight : 1));
  return node;
}

export function removePanel(tree, panelId) {
  const next = clone(tree);
  const leaf = findLeafByPanel(next, panelId);
  if (!leaf) return next;
  leaf.panels = leaf.panels.filter(id => id !== panelId);
  if (leaf.active === panelId) leaf.active = leaf.panels[0];
  const pruned = pruneSplit(next);
  return pruned;
}

// Drops panelId onto targetLeafId. zone 'center' joins the leaf's
// tabs; an edge splits the leaf in that direction. Moving a panel
// within its own leaf to its own edge is a no-op split-wise (it
// just re-activates).
export function movePanel(tree, panelId, targetLeafId, zone) {
  let next = clone(tree);
  const target = findLeafById(next, targetLeafId);
  if (!target) return next;
  const source = findLeafByPanel(next, panelId);
  if (source && source.id === target.id && zone === 'center') {
    target.active = panelId;
    return next;
  }
  if (source && source.id === target.id && source.panels.length === 1) {
    return next; // splitting a leaf against itself changes nothing
  }
  next = removePanel(next, panelId) || next;
  const anchor = findLeafById(next, targetLeafId);
  if (!anchor) {
    // The target leaf disappeared with the removal (it held only
    // the dragged panel's siblings). Fall back to a fresh root tab.
    const leaf = makeLeaf([panelId]);
    return next ? makeSplit('row', [3, 1], [next, leaf]) : leaf;
  }
  if (zone === 'center') {
    anchor.panels.push(panelId);
    anchor.active = panelId;
    return next;
  }
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';
  const newLeaf = makeLeaf([panelId]);
  // Rebuild: find the anchor's parent and splice, or wrap the root.
  const splice = node => {
    if (!node || node.kind !== 'split') return false;
    const index = node.children.indexOf(anchor);
    if (index >= 0) {
      if (node.dir === dir) {
        const half = node.weights[index] / 2;
        node.weights[index] = half;
        node.children.splice(before ? index : index + 1, 0, newLeaf);
        node.weights.splice(before ? index : index + 1, 0, half);
      } else {
        node.children[index] = makeSplit(dir, [1, 1], before ? [newLeaf, anchor] : [anchor, newLeaf]);
      }
      return true;
    }
    return node.children.some(splice);
  };
  if (next === anchor) {
    return makeSplit(dir, [1, 1], before ? [newLeaf, anchor] : [anchor, newLeaf]);
  }
  splice(next);
  return next;
}

// Header toggles / Panels checklist: make sure a panel is in the
// tree, placing it at its home edge when it is not.
export function ensurePanel(tree, panelId) {
  if (findLeafByPanel(tree, panelId)) return tree;
  const leaf = makeLeaf([panelId]);
  if (!tree) return leaf;
  if (panelId === 'navigator' || panelId === 'ai') {
    const atStart = panelId === 'navigator';
    if (tree.kind === 'split' && tree.dir === 'row') {
      const next = clone(tree);
      if (atStart) {
        next.children.unshift(leaf);
        next.weights.unshift(1);
      } else {
        next.children.push(leaf);
        next.weights.push(1.4);
      }
      return next;
    }
    return makeSplit('row', [1, 3], atStart ? [leaf, clone(tree)] : [clone(tree), leaf]);
  }
  // Other panels join the code leaf's tabs (or the first leaf's).
  const host = findLeafByPanel(tree, 'code') || findFirstLeaf(tree);
  return movePanel(tree, panelId, host.id, 'center');
}

function findFirstLeaf(tree) {
  if (!tree) return null;
  if (tree.kind === 'leaf') return tree;
  return findFirstLeaf(tree.children[0]);
}

// Loose equality for "is this preset the current arrangement":
// same shape and panels, weights within a hair (the resizer
// nudges them constantly).
export function sameTree(a, b) {
  const x = normalizeTree(clone(a));
  const y = normalizeTree(clone(b));
  if (!x || !y || x.kind !== y.kind) return false;
  if (x.kind === 'leaf') {
    return x.panels.join() === y.panels.join() && x.active === y.active;
  }
  return x.dir === y.dir
    && x.children.length === y.children.length
    && x.children.every((child, i) => sameTree(child, y.children[i])
      && Math.abs(x.weights[i] - y.weights[i]) < 0.08);
}

// --- legacy layouts (av-layouts-v1) -> tree ------------------------

export function treeFromLegacyLayout(layout) {
  if (!layout) return null;
  if (layout.mode === 'focus' && layout.focus) {
    const root = presetTree('Focus');
    const f = layout.focus;
    const outer = [];
    const outerWeights = [];
    if (!layout.visibles || layout.visibles[0]) {
      outer.push(makeLeaf(['navigator']));
      outerWeights.push(f.nav || 1);
    }
    outer.push(root.children[0], root.children[1]);
    outerWeights.push(f.cols[0], f.cols[1]);
    if (layout.visibles && layout.visibles[3]) {
      outer.push(makeLeaf(['ai']));
      outerWeights.push(f.ai || 1.6);
    }
    const left = root.children[0];
    const right = root.children[1];
    left.weights = [...f.rows];
    if (f.right) right.weights = [...f.right];
    return makeSplit('row', outerWeights, outer);
  }
  // strip
  const visibles = layout.visibles || [true, true, true, false];
  const weights = layout.weights || [1, 2, 2, 1.4];
  const children = [];
  const ws = [];
  if (visibles[0]) {
    children.push(makeLeaf(['navigator']));
    ws.push(weights[0]);
  }
  children.push(makeLeaf(['doc', 'viz'], 'doc'));
  ws.push(weights[1]);
  children.push(makeSplit('col', [2.7, 1], [makeLeaf(['code']), makeLeaf(['tests'])]));
  ws.push(weights[2]);
  if (visibles[3]) {
    children.push(makeLeaf(['ai']));
    ws.push(weights[3]);
  }
  return children.length === 1 ? children[0] : makeSplit('row', ws, children);
}

// --- store ----------------------------------------------------------

export function loadDockStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (parsed && typeof parsed === 'object') {
      const custom = (Array.isArray(parsed.custom) ? parsed.custom : [])
        .map(entry => (entry && typeof entry.name === 'string'
          ? { name: entry.name, tree: normalizeTree(clone(entry.tree)) } : null))
        .filter(entry => entry && entry.tree);
      const current = normalizeTree(clone(parsed.current));
      if (current) return { custom, current };
      return { custom, current: presetTree('Default') };
    }
  } catch (error) {
    // fall through to the legacy migration
  }
  // One-time migration from the old strip/focus layout store.
  try {
    const legacy = loadLayoutStore();
    const custom = (legacy.custom || [])
      .map(entry => ({ name: entry.name, tree: treeFromLegacyLayout(entry) }))
      .filter(entry => entry.tree);
    const current = treeFromLegacyLayout(legacy.current) || presetTree('Default');
    return { custom, current: normalizeTree(current) || presetTree('Default') };
  } catch (error) {
    return { custom: [], current: presetTree('Default') };
  }
}

export function saveDockStore({ custom, current }) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ custom, current }));
  } catch (error) {
    // Storage unavailable: the arrangement simply does not persist.
  }
}
