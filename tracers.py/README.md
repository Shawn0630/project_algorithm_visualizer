# tracers.py

> This directory is part of the project [Algorithm Visualizer](https://github.com/Shawn0630/project_algorithm_visualizer).

`tracers.py` is a visualization library for Python, ported from `tracers.java`
(same classes, same command protocol the frontend renders).

## Usage

```python
from algorithm_visualizer import Array1DTracer, Layout, LogTracer, Tracer, VerticalLayout

array_tracer = Array1DTracer('Array')
log_tracer = LogTracer('Console')
Layout.set_root(VerticalLayout([array_tracer, log_tracer]))

array_tracer.set([3, 1, 2])
Tracer.delay()          # step boundary; the line number is captured automatically
log_tracer.println('done')
```

Method names are snake_case (`select_row`, `add_node`, `set_root`, ...);
camelCase aliases from the Java/JS API (`selectRow`, `addNode`, `setRoot`)
are also available. `Tracer.delay()` records the caller's line number
(0-based, like the JS tracer) so the editor highlights the current line.

When the environment variable `ALGORITHM_VISUALIZER` is set, the recorded
commands are written to `visualization.json` in the working directory at
interpreter exit. The server (`server/src/tracers/py/PyTracer.ts`) runs user
code exactly that way: `python3 Main.py` in a temp directory with this
library's `src/` on `PYTHONPATH` and a 5-second time limit.

## Layout

- `src/algorithm_visualizer/__init__.py` — the whole library (Commander,
  Tracer, Layout, the array/chart/graph/log tracers, and Randomize).
