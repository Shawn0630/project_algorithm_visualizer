// Tracer-code folding for the code pad: the visualization
// instrumentation (library imports, tracer creations, layout
// calls, and statements that call methods on tracer variables)
// can be folded away so the core algorithm stays readable. The
// folding is purely visual - the Ace document text never
// changes, saved code is untouched, and any fold can be opened
// in the editor like any other fold.
//
// Detection is deliberately conservative: a line only counts
// when the STATEMENT is tracer business - an import/include of
// the library, a tracer/layout creation, a Tracer/Layout/
// Randomize static call, or a call on a variable that was
// assigned a tracer earlier in the file. Algorithm lines that
// merely mention a tracer inside a larger expression stay put.
const TRACER_TYPES = ['Array1DTracer', 'Array2DTracer', 'LogTracer', 'ChartTracer', 'GraphTracer'];
const TYPE_ALT = TRACER_TYPES.join('|');
const CREATION_ALT = [...TRACER_TYPES, 'HorizontalLayout', 'VerticalLayout'].join('|');

export const TRACER_FOLD_EVENT = 'av-tracer-fold-changed';
const STORAGE_KEY = 'av-hide-tracers';

// Hidden by default (that is the point of the feature); the
// code pad's footer toggle flips it and the choice persists.
export function tracerFoldEnabled() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === null ? true : value === '1';
  } catch (error) {
    return true;
  }
}

export function setTracerFoldEnabled(enabled) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch (error) {
    // Storage unavailable: the toggle still applies to the
    // current session through the event.
  }
  window.dispatchEvent(new window.Event(TRACER_FOLD_EVENT));
}

function collectTracerVars(lines) {
  const vars = new Set();
  const patterns = [
    // Python: arr = Array1DTracer('Array')
    new RegExp(`^\\s*(\\w+)\\s*=\\s*(?:${TYPE_ALT})\\s*\\(`),
    // JavaScript: const arr = new Array1DTracer('Array')
    new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*new\\s+(?:${TYPE_ALT})\\b`),
    // Java / C++: Array1DTracer arr = new Array1DTracer(...)
    new RegExp(`\\b(?:${TYPE_ALT})\\s+(\\w+)\\s*=`),
    // C++: ChartTracer chartTracer("Chart");
    new RegExp(`^\\s*(?:algorithm_visualizer::)?(?:${TYPE_ALT})\\s+(\\w+)\\s*\\(`),
  ];
  lines.forEach(line => {
    patterns.forEach(pattern => {
      const match = pattern.exec(line);
      if (match) vars.add(match[1]);
    });
  });
  return vars;
}

function isImportLine(trimmed, ext) {
  if (ext === 'py') return /^import\s+algorithm_visualizer\b/.test(trimmed) || /^from\s+algorithm_visualizer\s+import\b/.test(trimmed);
  if (ext === 'js') return /\brequire\(\s*['"]algorithm-visualizer['"]\s*\)/.test(trimmed) || /^import\s.*\balgorithm-visualizer\b/.test(trimmed);
  if (ext === 'java') return /^import\s+org\.algorithm_visualizer\./.test(trimmed);
  if (ext === 'cpp') return /^#include\s*[<"]algorithm-visualizer\.h[>"]/.test(trimmed) || /^#include\s*[<"]algorithm_visualizer/.test(trimmed);
  return /algorithm[-_]visualizer/.test(trimmed) && /^(import|#include|.*require\()/.test(trimmed);
}

function isTracerLine(trimmed, vars, ext) {
  if (!trimmed) return false;
  if (isImportLine(trimmed, ext)) return true;
  // Creations: new X(...) in js/java/cpp, X(...) assignment in
  // Python, Class var(...) construction in C++.
  if (new RegExp(`\\bnew\\s+(?:algorithm_visualizer::)?(?:${CREATION_ALT})\\s*\\(`).test(trimmed)) return true;
  if (new RegExp(`(?:^|=\\s*)(?:${CREATION_ALT})\\s*\\(`).test(trimmed) && ext === 'py') return true;
  if (new RegExp(`^(?:algorithm_visualizer::)?(?:${TYPE_ALT})\\s+\\w+\\s*\\(`).test(trimmed)) return true;
  // Static calls: Layout.set_root / Layout::setRoot,
  // Tracer.delay(), Randomize::Array1D(...), ...
  if (/^(?:algorithm_visualizer::)?(?:Layout|Tracer|Randomize)\s*(?:\.|::)\s*\w+\s*\(/.test(trimmed)) return true;
  // A statement calling a method on a known tracer variable.
  if (vars.size) {
    const varAlt = [...vars].map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (new RegExp(`^(?:this\\.)?(?:${varAlt})\\s*\\.\\s*\\w+\\s*\\(`).test(trimmed)) return true;
  }
  return false;
}

function bracketDelta(line) {
  let delta = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[' || ch === '{') delta += 1;
    else if (ch === ')' || ch === ']' || ch === '}') delta -= 1;
  }
  return delta;
}

// Returns [{startRow, endRow}] (0-based, inclusive) - maximal
// runs of tracer lines, with multi-line statements (an opening
// Layout.set_root( ... ) block) absorbed whole.
export function tracerFoldRanges(code, ext) {
  const lines = String(code || '').split('\n');
  const vars = collectTracerVars(lines);
  const flagged = new Array(lines.length).fill(false);
  lines.forEach((raw, i) => {
    if (!isTracerLine(raw.trim(), vars, ext)) return;
    flagged[i] = true;
    let balance = bracketDelta(raw);
    let k = i;
    while (balance > 0 && k + 1 < lines.length) {
      k += 1;
      flagged[k] = true;
      balance += bracketDelta(lines[k]);
    }
  });
  const ranges = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && flagged[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      ranges.push({ startRow: start, endRow: i - 1 });
      start = -1;
    }
  }
  return ranges;
}
