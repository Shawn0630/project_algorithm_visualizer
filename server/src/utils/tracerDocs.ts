import fs from 'fs';
import path from 'path';

// The tracer-library reference handed to the AI assistant, so it can
// write real instrumentation instead of guessing the API. Method
// tables were extracted from the actual library sources in this repo
// (tracers.java, tracers.py, and the JS library the others mirror);
// the worked examples are read from the repo's own content files so
// they can never drift from what the app ships.

type Method = [string, string, string]; // name, args, description

const CLASSES: { name: string, about: string, methods: Method[] }[] = [
  {
    name: 'Tracer (base of every view)',
    about: 'Every tracer shows one view. Create it with an optional title, load data with set(), then narrate the algorithm with the methods below.',
    methods: [
      ['set', 'data', 'replace the view content (per-subclass data shape)'],
      ['reset', '', 'clear the view'],
      ['delay', '', 'STATIC - capture one animation frame at the current execution point. Call it after every meaningful change or observation; the visualized line is taken from the call site. Nothing animates without delay() calls.'],
    ],
  },
  {
    name: 'Layout (static composition)',
    about: 'Arranges the views on screen. Build a VerticalLayout / HorizontalLayout from tracers (or nested layouts) and install it exactly once.',
    methods: [
      ['setRoot', 'layoutOrTracer', 'STATIC - install the root view tree. Place it once, before the first delay().'],
      ['add', 'child, index?', 'append a view to a layout dynamically (rarely needed)'],
      ['remove', 'child', 'remove a view from a layout'],
      ['removeAll', '', 'empty a layout'],
    ],
  },
  {
    name: 'Array1DTracer',
    about: 'One row of cells - arrays, lists, stacks. x is a 0-based index.',
    methods: [
      ['set', 'array', 'load a 1D array'],
      ['patch', 'x, value?', 'mark cell x as just-changed (highlight); also updates its displayed value when value is given'],
      ['depatch', 'x', 'remove the changed highlight from cell x'],
      ['select', 'x  |  sx, ex', 'mark one cell or the inclusive range sx..ex as selected (being examined)'],
      ['deselect', 'x  |  sx, ex', 'undo select'],
      ['chart', 'chartTracer', 'mirror this array into a ChartTracer so it also renders as bars'],
    ],
  },
  {
    name: 'Array2DTracer',
    about: 'A grid. x is the row, y is the column, both 0-based.',
    methods: [
      ['set', 'array2d', 'load a 2D array'],
      ['patch', 'x, y, value?', 'mark cell (x, y) as just-changed; optionally set its value'],
      ['depatch', 'x, y', 'remove the changed highlight'],
      ['select', 'x, y  |  sx, sy, ex, ey', 'mark one cell or the inclusive rectangle (sx, sy)..(ex, ey)'],
      ['selectRow', 'x, sy, ey', 'select row x, columns sy..ey'],
      ['selectCol', 'y, sx, ex', 'select column y, rows sx..ex'],
      ['deselect', 'x, y  |  sx, sy, ex, ey', 'undo select'],
      ['deselectRow', 'x, sy, ey', 'undo selectRow'],
      ['deselectCol', 'y, sx, ex', 'undo selectCol'],
    ],
  },
  {
    name: 'ChartTracer',
    about: 'An Array1DTracer rendered as bars - the right view for sorting. Same methods as Array1DTracer; usually paired via arrayTracer.chart(chartTracer) or fed the same data directly.',
    methods: [],
  },
  {
    name: 'GraphTracer',
    about: 'Nodes and edges for graph algorithms (BFS, DFS, Dijkstra, MST). Node ids are the values you pass (numbers or strings).',
    methods: [
      ['set', 'adjacencyMatrix', 'build the graph from a 2D matrix (0 = no edge, other values = weight); call a layout method afterwards'],
      ['directed', 'bool?', 'set directed edges; chainable, call before adding nodes/edges'],
      ['weighted', 'bool?', 'set weighted edges; chainable'],
      ['layoutCircle', '', 'place nodes on a circle'],
      ['layoutTree', 'root?, sorted?', 'place nodes as a tree under root'],
      ['layoutRandom', '', 'place nodes randomly'],
      ['addNode', 'id, weight?, x?, y?', 'add a node (x/y optional, 0..1 relative coordinates)'],
      ['updateNode', 'id, weight?, x?, y?', 'change a node'],
      ['removeNode', 'id', 'remove a node and its edges'],
      ['addEdge', 'source, target, weight?', 'add an edge'],
      ['updateEdge', 'source, target, weight?', 'change an edge'],
      ['removeEdge', 'source, target', 'remove an edge'],
      ['visit', 'target, source?, weight?', 'mark the traversal step into target (from source): the edge and node light up as visited'],
      ['leave', 'target, source?, weight?', 'mark backtracking out of target'],
      ['select', 'target, source?', 'mark a node (or the edge source->target) as selected/current'],
      ['deselect', 'target, source?', 'undo select'],
      ['log', 'logTracer', 'attach a LogTracer to this graph view'],
    ],
  },
  {
    name: 'LogTracer',
    about: 'A console view. Use it to narrate what the algorithm is doing (comparisons, swaps, decisions) in words.',
    methods: [
      ['set', 'text', 'replace the whole log'],
      ['print', 'message', 'append without a newline'],
      ['println', 'message', 'append with a newline'],
      ['printf', 'format, ...args', 'append printf-style (Java and Python; in JavaScript use println with a template literal instead)'],
    ],
  },
];

const RANDOMIZE: { [ext: string]: string } = {
  js: [
    'Randomize (test-data builders; the JS builders return the data directly):',
    '- Randomize.Array1D({ N, randomizer? }) -> array. Example: const D = Randomize.Array1D({ N: 15 });',
    '- Randomize.Array2D({ N, M, randomizer? }), Randomize.Graph({ N, ratio?, randomizer? })',
    '- Randomize.Integer({ min, max }), Randomize.Double({ min, max }), Randomize.String({ length, letters? }) - pass as the randomizer.',
  ].join('\n'),
  java: [
    'Randomize (builders return an object; call .create() to get the data):',
    '- new Randomize.Array1D(n, new Randomize.Integer(min, max)).create() -> Object[] of Integer',
    '- new Randomize.Array2D(n, m, randomizer).create(); .sorted() may be chained before create().',
    '- new Randomize.Integer(min, max), new Randomize.Double(min, max), new Randomize.String(length)',
    '- new Randomize.Graph(n, ratio, randomizer).directed().weighted().create() -> adjacency matrix',
  ].join('\n'),
  py: [
    'Randomize (builders return an object; call .create() to get the data):',
    '- Randomize.Array1D(n, randomizer=None).create() - default randomizer is Integer(1, 9); .sorted(True) may be chained before create().',
    '- Randomize.Array2D(n, m, randomizer=None).create()',
    '- Randomize.Integer(min=1, max=9), Randomize.Double(min=0, max=1), Randomize.String(length=16, letters=ascii_lowercase)',
    '- Randomize.Graph(n=5, ratio=0.3, randomizer=None).directed().weighted().create() -> adjacency matrix',
  ].join('\n'),
  cpp: [
    'Randomize is not part of the C++ library - build test data directly with std containers.',
  ].join('\n'),
};

const LANGUAGE_NOTES: { [ext: string]: string } = {
  js: 'JavaScript surface: camelCase methods. Import once: const { Tracer, Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer, Layout, VerticalLayout, HorizontalLayout, Randomize } = require(\'algorithm-visualizer\'); Constructors take an optional title: new Array1DTracer(\'Array\'). Tracer.delay() is static.',
  java: 'Java surface: camelCase methods. Import once: import org.algorithm_visualizer.*;. A STANDALONE pad file (no other class in it) defines public class Main with public static void main(String[] args) and the driver lives in main. A LeetCode-style file that already defines class Solution instead gets a NON-public class Main appended in the same file (two public classes in one file will not compile). Constructors take an optional title string: new LogTracer("Console"). Layout.setRoot takes a single Commander: use new VerticalLayout(new Commander[]{a, b}). Tracer.delay() is static. Randomize.Array1D(...).create() returns Object[] - cast, e.g. (Integer[]) ...create().',
  py: 'Python surface: snake_case methods (set_root, select_row, add_node, layout_circle, ...); the camelCase aliases also work but prefer snake_case. Import once: from algorithm_visualizer import *. Constructors take an optional title: LogTracer("Console"). Tracer.delay() is called with no argument - the line number is captured automatically. Randomize builders need .create().',
  cpp: 'C++ surface: camelCase methods, tracers are values (not pointers): Array2DTracer grid("Grid"); Include once: #include "algorithm-visualizer.h". Layout::setRoot takes a layout value built from an initializer list: Layout::setRoot(VerticalLayout({grid, logger})); Tracer::delay() is static. set() accepts std::vector data (nested vectors for 2D).',
};

const EXAMPLE_FILES: { [ext: string]: string } = {
  js: 'algorithms/Brute Force/Bubble Sort/code.js',
  py: 'algorithms/Brute Force/Bubble Sort/code.py',
  java: 'algorithms/Brute Force/Selection Sort/code.java',
  cpp: 'web/src/files/skeletons/code.cpp',
};

const exampleCache: { [ext: string]: string } = {};

function workedExample(ext: string): string {
  if (exampleCache[ext]) return exampleCache[ext];
  const rel = EXAMPLE_FILES[ext];
  let content = '';
  if (rel) {
    try {
      content = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');
    } catch (error) {
      content = '';
    }
  }
  exampleCache[ext] = content;
  return content;
}

const camelToSnake = (name: string) => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

// The shape a LeetCode-style pad must take: the user's class,
// untouched, plus a driver that makes it visualize. Models copy
// patterns far more reliably than they follow prose rules, so
// each language gets the concrete pattern to imitate.
const DRIVER_EXAMPLES: { [ext: string]: string } = {
  py: [
    'class Solution:',
    '    def search(self, nums, target):',
    '        # ... the user\'s algorithm, unchanged ...',
    '',
    '# --- driver: makes the class above visualize (appended, class untouched) ---',
    'array_tracer = Array1DTracer(\'Array\')',
    'logger = LogTracer(\'Console\')',
    'Layout.set_root(VerticalLayout([array_tracer, logger]))',
    'nums = [1, 3, 5, 7, 9]',
    'array_tracer.set(nums)',
    'logger.println(\'search [1, 3, 5, 7, 9] for 7\')',
    'Tracer.delay()',
    'result = Solution().search(nums, 7)',
    'logger.println(f\'result: {result}\')',
    'Tracer.delay()',
  ].join('\n'),
  js: [
    'class Solution {',
    '  search(nums, target) { /* ... the user\'s algorithm, unchanged ... */ }',
    '}',
    '',
    '// --- driver: makes the class above visualize (appended, class untouched) ---',
    'const arrayTracer = new Array1DTracer(\'Array\');',
    'const logger = new LogTracer(\'Console\');',
    'Layout.setRoot(new VerticalLayout([arrayTracer, logger]));',
    'const nums = [1, 3, 5, 7, 9];',
    'arrayTracer.set(nums);',
    'logger.println(\'search [1, 3, 5, 7, 9] for 7\');',
    'Tracer.delay();',
    'const result = new Solution().search(nums, 7);',
    'logger.println(`result: ${result}`);',
    'Tracer.delay();',
  ].join('\n'),
  java: [
    'class Solution {',
    '    public int search(int[] nums, int target) { /* ... unchanged ... */ }',
    '}',
    '',
    '// --- driver: a NON-public Main in the SAME file (a second public',
    '// class would not compile). Tests call Solution directly; this',
    '// main only runs when the pad is built / visualized. ---',
    'class Main {',
    '    public static void main(String[] args) {',
    '        Array1DTracer arrayTracer = new Array1DTracer("Array");',
    '        LogTracer logger = new LogTracer("Console");',
    '        Layout.setRoot(new VerticalLayout(new Commander[]{arrayTracer, logger}));',
    '        int[] nums = {1, 3, 5, 7, 9};',
    '        arrayTracer.set(nums);',
    '        logger.println("search for 7");',
    '        Tracer.delay();',
    '        int result = new Solution().search(nums, 7);',
    '        logger.println("result: " + result);',
    '        Tracer.delay();',
    '    }',
    '}',
  ].join('\n'),
  cpp: [
    'class Solution {',
    'public:',
    '    int search(vector<int>& nums, int target) { /* ... unchanged ... */ }',
    '};',
    '',
    '// --- driver: appended main() makes the class visualize ---',
    'int main() {',
    '    Array1DTracer arrayTracer("Array");',
    '    LogTracer logger("Console");',
    '    Layout::setRoot(VerticalLayout({arrayTracer, logger}));',
    '    vector<int> nums = {1, 3, 5, 7, 9};',
    '    arrayTracer.set(nums);',
    '    logger.println("search for 7");',
    '    Tracer::delay();',
    '    int result = Solution().search(nums, 7);',
    '    logger.println("result: " + std::to_string(result));',
    '    Tracer::delay();',
    '    return 0;',
    '}',
  ].join('\n'),
};

export function tracerReference(ext: string): string {
  const language = LANGUAGE_NOTES[ext] ? ext : 'js';
  const lines: string[] = [
    '=== Tracer library reference (the real API of this app - use ONLY these methods) ===',
    '',
    'How instrumentation works:',
    '1. Keep the user\'s algorithm logic and data identical; only ADD tracer calls and log lines.',
    '2. Put imports in the "// import visualization libraries {" section, tracer creation + Layout.setRoot + the initial set(...) in the "// define tracer variables {" section, step calls in "// visualize {" blocks next to the logic they describe, and narration in "// logger {" blocks (Python uses # comments, same markers).',
    '3. Feed the tracer the SAME live data the algorithm mutates: set() it once, then patch() on every write so the view tracks the real values - never visualize a copy.',
    '4. Rhythm: select() what is being examined -> delay() -> mutate -> patch() the changed cells -> delay() -> depatch()/deselect() to clean up. A change with no delay() after it never becomes a frame.',
    '5. Exactly one Layout.setRoot(...), placed before the first delay().',
    '6. If the file ONLY defines a class (e.g. a LeetCode-style class Solution) or functions and runs nothing at top level, NOTHING will visualize - a class definition alone produces no frames. Then APPEND a driver section at the very end of the file, in the shape of the per-language driver pattern below: create the tracers, set the layout root once, instantiate the class, call the method with a concrete example input, narrate the input and the result through a LogTracer, and delay() before and after the call. Keep the class itself unchanged unless the instruction asks to instrument its internals. JAVA WARNING: when the file already defines a class (Solution), the driver is a NON-public `class Main` with main() appended in the SAME file - a second PUBLIC class in one file does not compile. The test runner calls the Solution class directly, so the driver never interferes with tests.',
    '7. The ONLY visualization library in this app is algorithm_visualizer. There is NO module named py_viz (or anything similar), and there are NO tracer methods named set_variables or mark_line - never import a module or call a method that is not in this reference.',
    '8. Never initialize a tracer variable to None/null as a placeholder: if the algorithm reads a tracer through a global, that global must hold a real tracer BEFORE the algorithm runs - create the tracers at module level (or at the top of the driver, before the call) and only then invoke the code.',
    '',
    LANGUAGE_NOTES[language],
    '',
  ];
  for (const cls of CLASSES) {
    lines.push(`${cls.name}: ${cls.about}`);
    for (const [name, args, desc] of cls.methods) {
      const rendered = language === 'py' ? camelToSnake(name) : name;
      lines.push(`  ${rendered}(${args}) - ${desc}`);
    }
    lines.push('');
  }
  lines.push(RANDOMIZE[language], '');
  const example = workedExample(language);
  if (example) {
    lines.push('=== Complete worked example (real file from this app - follow its structure and idioms) ===');
    lines.push(example);
  }
  lines.push('', '=== Pattern for LeetCode-style pads (class + appended driver) ===', DRIVER_EXAMPLES[language]);
  return lines.join('\n');
}
