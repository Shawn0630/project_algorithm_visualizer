// Wraps a code pad's source with a small generated harness that
// calls the pad's test entry point (a Solution class method, or a
// top-level function - the same resolution the test runner uses)
// with ONE test case's arguments, inside the real tracer
// environment: a LogTracer narrates Input -> Output, and numeric
// arrays (arguments, and the return value) get Array1DTracer views.
// The wrapped source is what the Player builds and plays, so the
// case's execution animates in the visualization pane exactly like
// a hand-instrumented pad. The pad itself is never modified.
//
// Python and JavaScript are supported; other languages throw a
// plain-language error the panel shows as-is.
const ENTRY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function argsLiteral(args) {
  // A JSON string literal containing the JSON text: safe to embed
  // in Python, JavaScript and Java source alike.
  return JSON.stringify(JSON.stringify(args));
}

function pythonHarness(code, entry, args) {
  return `${code}

# ---- visualize this test case (auto-generated) ----
import json as _viz_json
from algorithm_visualizer import Tracer as _VizTracer, LogTracer as _VizLogTracer, Array1DTracer as _VizArray1DTracer, Layout as _VizLayout, VerticalLayout as _VizVerticalLayout

_viz_args = _viz_json.loads(${argsLiteral(args)})
_viz_log = _VizLogTracer()
_viz_views = []
for _viz_a in _viz_args:
    if isinstance(_viz_a, list) and _viz_a and all(isinstance(_viz_x, (int, float)) and not isinstance(_viz_x, bool) for _viz_x in _viz_a):
        _viz_t = _VizArray1DTracer()
        _viz_t.set(_viz_a)
        _viz_views.append(_viz_t)
_viz_result_tracer = _VizArray1DTracer()
_viz_views.append(_viz_result_tracer)
_viz_views.append(_viz_log)
_VizLayout.set_root(_VizVerticalLayout(_viz_views))
_viz_target = None
_viz_cls = globals().get('Solution')
if _viz_cls is not None and hasattr(_viz_cls, '${entry}'):
    _viz_target = getattr(_viz_cls(), '${entry}')
elif callable(globals().get('${entry}')):
    _viz_target = globals()['${entry}']
if _viz_target is None:
    _viz_log.println('No method ${entry} found (looked for a Solution class method and a top-level function)')
else:
    _viz_log.println('Input: ' + _viz_json.dumps(_viz_args))
    _VizTracer.delay()
    _viz_result = _viz_target(*_viz_args)
    if isinstance(_viz_result, list) and _viz_result and all(isinstance(_viz_x, (int, float)) and not isinstance(_viz_x, bool) for _viz_x in _viz_result):
        _viz_result_tracer.set(_viz_result)
    _viz_log.println('Output: ' + _viz_json.dumps(_viz_result, default=repr))
    _VizTracer.delay()
`;
}

function jsHarness(code, entry, args) {
  return `${code}

// ---- visualize this test case (auto-generated) ----
const _viz = require('algorithm-visualizer');
const _vizArgs = JSON.parse(${argsLiteral(args)});
const _vizLog = new _viz.LogTracer();
const _vizViews = [];
_vizArgs.forEach(a => {
  if (Array.isArray(a) && a.length && a.every(x => typeof x === 'number')) {
    const t = new _viz.Array1DTracer();
    t.set(a);
    _vizViews.push(t);
  }
});
const _vizResultTracer = new _viz.Array1DTracer();
_vizViews.push(_vizResultTracer, _vizLog);
_viz.Layout.setRoot(new _viz.VerticalLayout(_vizViews));
let _vizTarget = null;
if (typeof Solution === 'function' && Solution.prototype && typeof Solution.prototype['${entry}'] === 'function') {
  const _vizInstance = new Solution();
  _vizTarget = (...a) => _vizInstance['${entry}'](...a);
} else if (typeof ${entry} === 'function') {
  _vizTarget = ${entry};
}
if (!_vizTarget) {
  _vizLog.println('No function ${entry} found (looked for a Solution class method and a top-level function)');
} else {
  _vizLog.println('Input: ' + JSON.stringify(_vizArgs));
  _viz.Tracer.delay();
  const _vizResult = _vizTarget(..._vizArgs);
  if (Array.isArray(_vizResult) && _vizResult.length && _vizResult.every(x => typeof x === 'number')) {
    _vizResultTracer.set(_vizResult);
  }
  _vizLog.println('Output: ' + (typeof _vizResult === 'object' ? JSON.stringify(_vizResult) : String(_vizResult)));
  _viz.Tracer.delay();
}
`;
}

export function buildCaseVisualization(ext, code, entry, args) {
  if (!ENTRY_PATTERN.test(entry || '')) {
    throw new Error(`"${entry}" is not a valid function/method name.`);
  }
  if (ext === 'py') return pythonHarness(code, entry, args);
  if (ext === 'js') return jsHarness(code, entry, args);
  throw new Error(`Visualizing a case is not supported for .${ext} files yet (Python and JavaScript are).`);
}
