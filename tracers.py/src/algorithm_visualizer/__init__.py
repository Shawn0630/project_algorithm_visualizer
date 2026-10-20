"""algorithm_visualizer — visualization library for Python.

A port of tracers.java (org.algorithm_visualizer): user code builds tracers
and layouts, every call is recorded as a command, and at interpreter exit
the command list is written to ``visualization.json`` in the working
directory when the environment variable ``ALGORITHM_VISUALIZER`` is set
(the server sets it; the file is what the frontend renders).

Method names are snake_case; camelCase aliases matching the Java/JS API
(e.g. ``select_row`` / ``selectRow``) are provided for every multi-word
method so examples from the other languages transliterate mechanically.
The commands on the wire always use the camelCase names the frontend
dispatches on.
"""

import atexit
import inspect
import json
import math
import os
import random
import string as _string_module

__all__ = [
    "Commander",
    "Tracer",
    "Layout",
    "HorizontalLayout",
    "VerticalLayout",
    "Array1DTracer",
    "Array2DTracer",
    "ChartTracer",
    "GraphTracer",
    "LogTracer",
    "Randomize",
]

_MAX_COMMANDS = 1000000
_MAX_OBJECTS = 100
_KEY_LETTERS = _string_module.ascii_lowercase + _string_module.digits

_MISSING = object()


def _random_key():
    return "".join(random.choice(_KEY_LETTERS) for _ in range(8))


def _to_jsonable(value):
    if isinstance(value, Commander):
        return value.key
    if isinstance(value, float) and not math.isfinite(value):
        # JSON.stringify(Infinity/NaN) is null; match that instead of
        # emitting Python json's invalid Infinity/NaN tokens.
        return None
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


def _normalize(args):
    # Mirror the Java library's Gson round-trip: arguments reach the wire
    # exactly as JSON would carry them (tuples become arrays, tracer and
    # layout objects become their key strings).
    return json.loads(json.dumps(_to_jsonable(list(args))))


def _trim(args):
    args = list(args)
    while args and args[-1] is None:
        args.pop()
    return args


class Commander:
    """Base class of every tracer and layout; records the command stream."""

    _commands = []
    _object_count = 0

    def __init__(self, args=()):
        Commander._object_count += 1
        if Commander._object_count > _MAX_OBJECTS:
            raise RuntimeError("Too Many Objects")
        self.key = _random_key()
        Commander._append(self.key, type(self).__name__, args)

    @staticmethod
    def _append(key, method, args):
        Commander._commands.append(
            {"key": key, "method": method, "args": _normalize(args)}
        )
        if len(Commander._commands) > _MAX_COMMANDS:
            raise RuntimeError("Too Many Commands")

    def _command(self, method, args=()):
        Commander._append(self.key, method, args)

    def destroy(self):
        Commander._object_count -= 1
        self._command("destroy", [])


def _flush_commands():
    if os.environ.get("ALGORITHM_VISUALIZER"):
        with open("visualization.json", "w") as f:
            json.dump(Commander._commands, f)


atexit.register(_flush_commands)


class Tracer(Commander):
    def __init__(self, title=None):
        super().__init__([title] if title is not None else [])

    @staticmethod
    def delay(line_number=None):
        """Mark a step boundary. Without an argument, the caller's line
        number is captured automatically (0-based, matching the line index
        the JS tracer's worker injects)."""
        if line_number is None:
            frame = inspect.currentframe()
            try:
                line_number = frame.f_back.f_lineno - 1
            finally:
                del frame
        Commander._append(None, "delay", [line_number])

    def set(self):
        self._command("set", [])

    def reset(self):
        self._command("reset", [])


class Layout(Commander):
    def __init__(self, children):
        super().__init__([list(children)])

    @staticmethod
    def set_root(child):
        Commander._append(None, "setRoot", [child])

    # camelCase alias, matching the other languages' spelling
    setRoot = staticmethod(set_root)

    def add(self, child, index=None):
        if index is None:
            self._command("add", [child])
        else:
            self._command("add", [child, index])

    def remove(self, child):
        self._command("remove", [child])

    def remove_all(self):
        self._command("removeAll", [])

    removeAll = remove_all


class HorizontalLayout(Layout):
    pass


class VerticalLayout(Layout):
    pass


class Array2DTracer(Tracer):
    def set(self, array2d):
        self._command("set", [array2d])

    def patch(self, x, y, v=_MISSING):
        if v is _MISSING:
            self._command("patch", [x, y])
        else:
            self._command("patch", [x, y, v])

    def depatch(self, x, y):
        self._command("depatch", [x, y])

    def select(self, sx, sy=None, ex=None, ey=None):
        if ex is None:
            self._command("select", [sx, sy])
        else:
            self._command("select", [sx, sy, ex, ey])

    def select_row(self, x, sy, ey):
        self._command("selectRow", [x, sy, ey])

    def select_col(self, y, sx, ex):
        self._command("selectCol", [y, sx, ex])

    def deselect(self, sx, sy=None, ex=None, ey=None):
        if ex is None:
            self._command("deselect", [sx, sy])
        else:
            self._command("deselect", [sx, sy, ex, ey])

    def deselect_row(self, x, sy, ey):
        self._command("deselectRow", [x, sy, ey])

    def deselect_col(self, y, sx, ex):
        self._command("deselectCol", [y, sx, ex])

    selectRow = select_row
    selectCol = select_col
    deselectRow = deselect_row
    deselectCol = deselect_col


class Array1DTracer(Array2DTracer):
    def set(self, array1d):
        self._command("set", [array1d])

    def patch(self, x, v=_MISSING):
        if v is _MISSING:
            self._command("patch", [x])
        else:
            self._command("patch", [x, v])

    def depatch(self, x):
        self._command("depatch", [x])

    def select(self, sx, ex=None):
        if ex is None:
            self._command("select", [sx])
        else:
            self._command("select", [sx, ex])

    def deselect(self, sx, ex=None):
        if ex is None:
            self._command("deselect", [sx])
        else:
            self._command("deselect", [sx, ex])

    def chart(self, chart_tracer):
        self._command("chart", [chart_tracer])


class ChartTracer(Array1DTracer):
    pass


class GraphTracer(Tracer):
    def set(self, array2d):
        self._command("set", [array2d])

    def directed(self, is_directed=None):
        self._command("directed", [] if is_directed is None else [is_directed])
        return self

    def weighted(self, is_weighted=None):
        self._command("weighted", [] if is_weighted is None else [is_weighted])
        return self

    def layout_circle(self):
        self._command("layoutCircle", [])
        return self

    def layout_tree(self, root=None, sorted=None):
        args = []
        if root is not None:
            args = [root]
            if sorted is not None:
                args = [root, sorted]
        self._command("layoutTree", args)
        return self

    def layout_random(self):
        self._command("layoutRandom", [])
        return self

    layoutCircle = layout_circle
    layoutTree = layout_tree
    layoutRandom = layout_random

    def add_node(self, id, weight=None, x=None, y=None,
                 visited_count=None, selected_count=None):
        self._command("addNode", _trim(
            [id, weight, x, y, visited_count, selected_count]))

    def update_node(self, id, weight=None, x=None, y=None,
                    visited_count=None, selected_count=None):
        self._command("updateNode", _trim(
            [id, weight, x, y, visited_count, selected_count]))

    def remove_node(self, id):
        self._command("removeNode", [id])

    addNode = add_node
    updateNode = update_node
    removeNode = remove_node

    def add_edge(self, source, target, weight=None,
                 visited_count=None, selected_count=None):
        self._command("addEdge", _trim(
            [source, target, weight, visited_count, selected_count]))

    def update_edge(self, source, target, weight=None,
                    visited_count=None, selected_count=None):
        self._command("updateEdge", _trim(
            [source, target, weight, visited_count, selected_count]))

    def remove_edge(self, source, target):
        self._command("removeEdge", [source, target])

    addEdge = add_edge
    updateEdge = update_edge
    removeEdge = remove_edge

    def visit(self, target, source=None, weight=None):
        self._command("visit", _trim([target, source, weight]))

    def leave(self, target, source=None, weight=None):
        self._command("leave", _trim([target, source, weight]))

    def select(self, target, source=None):
        self._command("select", _trim([target, source]))

    def deselect(self, target, source=None):
        self._command("deselect", _trim([target, source]))

    def log(self, log_tracer):
        self._command("log", [log_tracer])


class LogTracer(Tracer):
    def set(self, log):
        self._command("set", [log])

    def print(self, message):
        self._command("print", [message])

    def println(self, message):
        self._command("println", [message])

    def printf(self, format, *args):
        self._command("printf", [format] + list(args))


class Randomize:
    """Random data generators, mirroring org.algorithm_visualizer.Randomize."""

    class Integer:
        def __init__(self, min=1, max=9):
            self._min = min
            self._max = max

        def create(self):
            return random.randint(self._min, self._max)

    class Double:
        def __init__(self, min=0, max=1):
            self._min = min
            self._max = max

        def create(self):
            return random.random() * (self._max - self._min) + self._min

    class String:
        def __init__(self, length=16, letters=_string_module.ascii_lowercase):
            self._length = length
            self._letters = letters

        def create(self):
            picker = Randomize.Integer(0, len(self._letters) - 1)
            return "".join(self._letters[picker.create()]
                           for _ in range(self._length))

    class Array1D:
        def __init__(self, n=10, randomizer=None):
            self._n = n
            self._randomizer = randomizer or Randomize.Integer()
            self._sorted = False

        def sorted(self, sorted=True):
            self._sorted = sorted
            return self

        def create(self):
            data = [self._randomizer.create() for _ in range(self._n)]
            if self._sorted:
                data.sort()
            return data

    class Array2D:
        def __init__(self, n=10, m=10, randomizer=None):
            self._n = n
            self._m = m
            self._randomizer = randomizer or Randomize.Integer()
            self._sorted = False

        def sorted(self, sorted=True):
            self._sorted = sorted
            return self

        def create(self):
            rows = []
            for _ in range(self._n):
                row = [self._randomizer.create() for _ in range(self._m)]
                if self._sorted:
                    row.sort()
                rows.append(row)
            return rows

    class Graph:
        def __init__(self, n=5, ratio=0.3, randomizer=None):
            self._n = n
            self._ratio = ratio
            self._randomizer = randomizer or Randomize.Integer()
            self._directed = True
            self._weighted = False

        def directed(self, directed=True):
            self._directed = directed
            return self

        def weighted(self, weighted=True):
            self._weighted = weighted
            return self

        def create(self):
            graph = [[0] * self._n for _ in range(self._n)]
            for i in range(self._n):
                for j in range(self._n):
                    if i == j:
                        graph[i][j] = 0
                    elif self._directed or i < j:
                        if random.random() < self._ratio:
                            graph[i][j] = (self._randomizer.create()
                                           if self._weighted else 1)
                        else:
                            graph[i][j] = 0
                    else:
                        graph[i][j] = graph[j][i]
            return graph
