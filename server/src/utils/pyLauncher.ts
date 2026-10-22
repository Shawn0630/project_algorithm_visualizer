// The launcher every Python visualization run goes through
// (PyTracer and the AI assistant's dry runs share it). It imports
// algorithm_visualizer FIRST and pre-injects all of its public
// names as globals for the user's Main.py, run via runpy as
// __main__: code that uses Tracer / Array1DTracer / LogTracer /
// Layout ... without importing them - the classic AI mistake -
// just works, while code that imports the library itself is
// unaffected. runpy keeps Main.py's own line numbers, so the
// line indicator still matches the editor exactly. Importing the
// module also registers its atexit flush, which writes
// visualization.json in the working directory at the end.
export const PY_LAUNCHER_SOURCE = `import algorithm_visualizer as _av
import runpy as _runpy
import sys as _sys

_globals = {name: getattr(_av, name) for name in dir(_av) if not name.startswith('_')}
_globals['algorithm_visualizer'] = _av
_sys.argv = ['Main.py']
_runpy.run_path('Main.py', init_globals=_globals, run_name='__main__')
`;
