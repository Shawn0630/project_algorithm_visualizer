const process = { env: { ALGORITHM_VISUALIZER: '1' } };
importScripts('/api/tracers/js');

const sandbox = code => {
  const require = name => ({ 'algorithm-visualizer': AlgorithmVisualizer }[name]); // fake require
  eval(code);
};

onmessage = e => {
  // Inject each call site's line number into delay() calls FIRST,
  // on the user's original lines, so reported line numbers always
  // match the editor exactly.
  const lines = e.data.split('\n').map((line, i) => line.replace(/(\.\s*delay\s*)\(\s*\)/g, `$1(${i})`));
  let code = lines.join('\n');
  // Force-import: code that uses the tracer names without ever
  // requiring the library gets the standard destructure prepended,
  // so a missing import can no longer break a run. Code that
  // requires the library itself is left untouched (a second
  // destructure of the same names would be a SyntaxError). The
  // prepended line sits before every rewritten delay(), and the
  // delay numbers were computed from the original lines above, so
  // the editor's line indicator is unaffected.
  if (!/require\(\s*['"]algorithm-visualizer['"]\s*\)/.test(e.data)) {
    code = 'const { Tracer, Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer, Layout, VerticalLayout, HorizontalLayout, Randomize } = require(\'algorithm-visualizer\');\n' + code;
  }
  sandbox(code);
  postMessage(AlgorithmVisualizer.Commander.commands);
};
