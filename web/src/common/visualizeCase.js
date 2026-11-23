// Wraps a code pad's source with a small generated harness that
// calls the pad's test entry point (a Solution class method, a
// method on the file's public class, or a top-level function - the
// same resolution the test runner uses) with ONE test case's
// arguments, inside the real tracer environment: a LogTracer
// narrates Input -> Output, and numeric arrays (arguments, and the
// return value) get Array1DTracer views.
// The wrapped source is what the Player builds and plays, so the
// case's execution animates in the visualization pane exactly like
// a hand-instrumented pad. The pad itself is never modified.
//
// ONLY the selected case runs: the pad's own top-level code (a
// driver section, demo calls, a loop over its own example cases)
// still executes once - its definitions are needed - but the
// harness's first act is to empty the central command list
// (Commander._commands / Commander.commands) that every tracer
// records into, so none of the pad's own frames reach the
// player. The Python harness then replays the creation commands
// of the pad's live tracers/layouts (Commander.replay_creates)
// and puts the pad's own root above the harness views: the case
// may call into an instrumented pad, and those objects are still
// alive - without the replay their calls would arrive at the
// frontend under keys it never saw created. Java needs none of
// this: the harness is the only entry point - either the file's
// own Main, with its demo main() replaced by the case call, or
// an appended Main - so nothing else in the file can run.
const ENTRY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// An entry may be a bare method name ("search") or the
// ClassName.method form ("Solution.search"); both are accepted
// everywhere the test runner accepts them. Returns null for
// anything else.
function parseEntry(entry) {
  const parts = String(entry || '').trim().split('.');
  if (parts.length === 1 && ENTRY_PATTERN.test(parts[0])) {
    return { className: null, method: parts[0] };
  }
  if (parts.length === 2 && ENTRY_PATTERN.test(parts[0]) && ENTRY_PATTERN.test(parts[1])) {
    return { className: parts[0], method: parts[1] };
  }
  return null;
}

function argsLiteral(args) {
  // A JSON string literal containing the JSON text: safe to embed
  // in Python, JavaScript and Java source alike.
  return JSON.stringify(JSON.stringify(args));
}

function pythonHarness(code, entry, args) {
  return `${code}

# ---- visualize this test case (auto-generated) ----
import json as _viz_json
from algorithm_visualizer import Commander as _VizCommander, Tracer as _VizTracer, LogTracer as _VizLogTracer, Array1DTracer as _VizArray1DTracer, Layout as _VizLayout, VerticalLayout as _VizVerticalLayout

# Discard everything the file's own top-level code recorded
# (its driver / demo runs): only the selected case plays.
# Then re-create the pad's own tracers/layouts: their creation
# commands were discarded with the driver's frames, but the
# objects are still alive and the case below still talks to
# them - without the replay, every such call arrives at the
# frontend under a key it never saw created, and the viewer
# fails on each of them.
del _VizCommander._commands[:]
_VizCommander.replay_creates()
_viz_pad_root = _VizCommander._root
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
if isinstance(_viz_pad_root, _VizCommander):
    # The pad already has its own visualization, and the case
    # below animates through its tracers: keep that at the top
    # and put the harness views underneath it.
    _VizLayout.set_root(_VizVerticalLayout([_viz_pad_root] + _viz_views))
else:
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
  // The require below is spelled with a concatenated name on
  // purpose: the JS worker decides whether to prepend its
  // tracer destructure by scanning the source for a literal
  // require('algorithm-visualizer'), and that decision must be
  // based on the PAD's code alone - if the wrapper's own
  // require suppressed the prepend, pads that rely on it
  // (tracer names without their own require) would break.
  return `${code}

// ---- visualize this test case (auto-generated) ----
const _viz = require('algorithm' + '-visualizer');
// Discard everything the file's own top-level code recorded
// (its driver / demo runs): only the selected case plays.
_viz.Commander.commands.length = 0;
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

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A mask of the Java source: mask[i] is true when position i is real
// code, false when it is inside a string literal, a char literal, a
// line/block comment or a text block. Brace matching and declaration
// searches only look at real code, so a "{" in a log string or a
// commented-out method can never confuse them.
function javaCodeMask(code) {
  const mask = new Array(code.length).fill(true);
  const blank = (from, to) => { for (let j = from; j < to; j++) mask[j] = false; };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      while (i < code.length && code[i] !== '\n') i++;
      blank(start, i);
    } else if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i = Math.min(code.length, i + 2);
      blank(start, i);
    } else if (c === '"') {
      if (code[i + 1] === '"' && code[i + 2] === '"') {
        // Text block: """ ... """
        const start = i;
        i += 3;
        while (i < code.length && !(code[i] === '"' && code[i + 1] === '"' && code[i + 2] === '"')) {
          if (code[i] === '\\') i++;
          i++;
        }
        i = Math.min(code.length, i + 3);
        blank(start, i);
      } else {
        const start = i;
        i++;
        while (i < code.length && code[i] !== '"') {
          if (code[i] === '\\') i++;
          i++;
        }
        i = Math.min(code.length, i + 1);
        blank(start, i);
      }
    } else if (c === "'") {
      const start = i;
      i++;
      while (i < code.length && code[i] !== "'") {
        if (code[i] === '\\') i++;
        i++;
      }
      i = Math.min(code.length, i + 1);
      blank(start, i);
    } else {
      i++;
    }
  }
  return mask;
}

// The first match of a global regex whose start is real code, or null.
// (Callers must pass a regex with the /g flag.)
function firstCodeMatch(code, mask, re) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (mask[m.index]) return m;
    if (m[0].length === 0) re.lastIndex++;
  }
  return null;
}

// First index at or after `from` where `ch` occurs in real code, or -1.
function indexOfCodeChar(code, mask, ch, from) {
  for (let i = from; i < code.length; i++) {
    if (mask[i] && code[i] === ch) return i;
  }
  return -1;
}

// The index of the `}` matching the `{` at openIndex (real code only),
// or -1 when the braces are unbalanced.
function matchingBrace(code, mask, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (!mask[i]) continue;
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// A main(String[] ...) declaration, in its usual spellings
// (String[] args, String args[], String... args, final String[] args).
const MAIN_DECL = /\b(?:public\s+)?static\s+void\s+main\s*\(\s*(?:final\s+)?String\s*(?:\[\s*\]|\.\.\.)?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\[\s*\])?\s*\)/g;

// The file with main()'s body replaced by `newBody` (one complete
// statement). Returns null when the file has no main() or its braces
// are unbalanced.
function replaceMainBody(code, mask, newBody) {
  const decl = firstCodeMatch(code, mask, MAIN_DECL);
  if (!decl) return null;
  const open = indexOfCodeChar(code, mask, '{', decl.index + decl[0].length);
  if (open < 0) return null;
  const close = matchingBrace(code, mask, open);
  if (close < 0) return null;
  return code.slice(0, open + 1) + '\n        ' + newBody + '\n    ' + code.slice(close);
}

// The file with a main() added to its Main class, calling `newBody`.
// Returns null when the file has no Main class or its braces are
// unbalanced.
function addMainMethod(code, mask, newBody) {
  const decl = firstCodeMatch(code, mask, /\bclass\s+Main\b/g);
  if (!decl) return null;
  const open = indexOfCodeChar(code, mask, '{', decl.index + decl[0].length);
  if (open < 0) return null;
  const close = matchingBrace(code, mask, open);
  if (close < 0) return null;
  const method = '\n    public static void main(String[] argv) {\n        ' + newBody + '\n    }\n';
  return code.slice(0, close) + method + code.slice(close);
}

// Imports the harness needs. A file that already imports a type
// from one of these packages (wildcard or single-class) needs no
// further import for it.
const JAVA_HARNESS_IMPORTS = [
  'org.algorithm_visualizer.*',
  'com.google.gson.*',
  'java.lang.reflect.*',
  'java.util.*',
];

function ensureJavaImports(code, mask) {
  const missing = JAVA_HARNESS_IMPORTS.filter(pkg => {
    const base = pkg.replace(/\.\*$/, '');
    return !firstCodeMatch(code, mask, new RegExp(`^\\s*import\\s+${escapeRegExp(base)}\\.(\\*|[A-Z])`, 'gm'));
  });
  if (missing.length === 0) return code;
  const imports = missing.map(pkg => `import ${pkg};`).join('\n') + '\n';
  const pkgDecl = firstCodeMatch(code, mask, /\bpackage\s+[\w.]+\s*;/g);
  if (pkgDecl) {
    const at = pkgDecl.index + pkgDecl[0].length;
    return code.slice(0, at) + '\n' + imports + code.slice(at);
  }
  return imports + code;
}

// The generated source is written out as Main.java, so the file's
// public class must be Main (or none): demote any other public
// class to package-private, keeping final/abstract modifiers.
function demotePublicClass(code, mask) {
  const pub = firstCodeMatch(code, mask, /\bpublic\s+((?:final\s+|abstract\s+)*)class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g);
  if (!pub || pub[2] === 'Main') return code;
  return code.slice(0, pub.index) + (pub[1] || '') + 'class ' + pub[2] + code.slice(pub.index + pub[0].length);
}

// Entry-class resolution, mirroring the test runner
// (server/src/utils/testRunner.ts): the entry's own class part, else
// a Solution class the file declares, else the file's public class,
// else Solution.
function resolveJavaEntryClass(code, mask, className) {
  if (className) return className;
  if (firstCodeMatch(code, mask, /\bclass\s+Solution\b/g)) return 'Solution';
  const pub = firstCodeMatch(code, mask, /\bpublic\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g);
  return pub ? pub[1] : 'Solution';
}

// The harness itself, shared by both shapes: a package-private
// helper class appended to the file. run() parses the case args,
// builds the harness views, finds the entry method on the given
// class and invokes it - with a null target for a static entry
// (constructing the class could run a demo constructor), and only
// an instance entry is instantiated, like the test runner.
// Nothing here throws: a failure is reported on the log tracer
// instead of crashing the run, because the harness may be spliced
// into the file's own main(), whose signature the harness does
// not own.
const JAVA_VIZ_HARNESS = `
// ---- visualize this test case (auto-generated) ----
class VizHarness {
    static final Gson GSON = new Gson();

    static boolean isNumericArray(JsonElement e) {
        if (e == null || !e.isJsonArray()) return false;
        JsonArray a = e.getAsJsonArray();
        if (a.size() == 0) return false;
        for (JsonElement item : a) {
            if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isNumber()) return false;
        }
        return true;
    }

    static Object[] toObjectArray(JsonArray a) {
        Object[] out = new Object[a.size()];
        for (int i = 0; i < a.size(); i++) out[i] = a.get(i).getAsNumber();
        return out;
    }

    static Object convert(JsonElement e, Class<?> t) {
        if (e == null || e.isJsonNull()) return null;
        if (t == String.class) return e.getAsString();
        if (t == int.class || t == Integer.class) return e.getAsInt();
        if (t == long.class || t == Long.class) return e.getAsLong();
        if (t == double.class || t == Double.class) return e.getAsDouble();
        if (t == float.class || t == Float.class) return e.getAsFloat();
        if (t == boolean.class || t == Boolean.class) return e.getAsBoolean();
        if (t == char.class || t == Character.class) return e.getAsString().charAt(0);
        if (t.isArray()) {
            JsonArray arr = e.getAsJsonArray();
            Class<?> comp = t.getComponentType();
            Object out = Array.newInstance(comp, arr.size());
            for (int i = 0; i < arr.size(); i++) Array.set(out, i, convert(arr.get(i), comp));
            return out;
        }
        if (List.class.isAssignableFrom(t)) {
            List<Object> out = new ArrayList<>();
            for (JsonElement item : e.getAsJsonArray()) out.add(GSON.fromJson(item, Object.class));
            return out;
        }
        if (t == Object.class) return GSON.fromJson(e, Object.class);
        throw new RuntimeException("Unsupported argument type: " + t.getName());
    }

    static void run(Class<?> entryClass, String entry, String argsJson) {
        JsonArray vizArgs = new JsonParser().parse(argsJson).getAsJsonArray();
        LogTracer log = new LogTracer();
        ArrayList<Commander> views = new ArrayList<>();
        for (JsonElement e : vizArgs) {
            if (isNumericArray(e)) {
                Array1DTracer t = new Array1DTracer();
                t.set(toObjectArray(e.getAsJsonArray()));
                views.add(t);
            }
        }
        Array1DTracer resultTracer = new Array1DTracer();
        views.add(resultTracer);
        views.add(log);
        Layout.setRoot(new VerticalLayout(views.toArray(new Commander[0])));
        Method method = null;
        for (Method m : entryClass.getDeclaredMethods()) {
            if (m.getName().equals(entry) && m.getParameterCount() == vizArgs.size() && !m.isBridge()) method = m;
        }
        if (method == null) {
            log.println("No method " + entry + " taking " + vizArgs.size() + " argument(s) found on class " + entryClass.getSimpleName());
            Tracer.delay();
            return;
        }
        method.setAccessible(true);
        Object target = null;
        if (!Modifier.isStatic(method.getModifiers())) {
            try {
                Constructor<?> ctor = entryClass.getDeclaredConstructor();
                ctor.setAccessible(true);
                target = ctor.newInstance();
            } catch (Exception e) {
                log.println("Cannot create a " + entryClass.getSimpleName() + " (it needs an accessible no-arg constructor): " + e);
                Tracer.delay();
                return;
            }
        }
        try {
            Class<?>[] types = method.getParameterTypes();
            Object[] callArgs = new Object[vizArgs.size()];
            for (int i = 0; i < vizArgs.size(); i++) callArgs[i] = convert(vizArgs.get(i), types[i]);
            log.println("Input: " + vizArgs.toString());
            Tracer.delay();
            Object result = method.invoke(target, callArgs);
            JsonElement resultJson = GSON.toJsonTree(result);
            if (isNumericArray(resultJson)) resultTracer.set(toObjectArray(resultJson.getAsJsonArray()));
            log.println("Output: " + GSON.toJson(result));
            Tracer.delay();
        } catch (Exception e) {
            Throwable cause = (e instanceof InvocationTargetException && e.getCause() != null) ? e.getCause() : e;
            log.println("Case failed: " + cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage()));
            Tracer.delay();
        }
    }
}
`;

function javaHarness(code, entry, args, className) {
  const mask = javaCodeMask(code);
  const entryClass = resolveJavaEntryClass(code, mask, className);
  if (!firstCodeMatch(code, mask, new RegExp(`\\bclass\\s+${escapeRegExp(entryClass)}\\b`, 'g'))) {
    throw new Error(`Visualizing a case needs a class ${entryClass} in the Java file (the harness adds a Main that calls its entry method).`);
  }
  const runCall = `VizHarness.run(${entryClass}.class, "${entry}", ${argsLiteral(args)});`;
  const withImports = ensureJavaImports(code, mask);
  const demoted = demotePublicClass(withImports, javaCodeMask(withImports));
  const demotedMask = javaCodeMask(demoted);
  if (firstCodeMatch(demoted, demotedMask, /\bclass\s+Main\b/g)) {
    // The file already defines Main: its main() is the demo driver,
    // not the selected case. Run the case from it instead - replace
    // the demo main's body with the harness call (or add a main
    // when the class has none) - and append the shared harness.
    // The pad itself is never modified: this is the generated copy.
    const replaced = replaceMainBody(demoted, demotedMask, runCall);
    if (replaced) return `${replaced}\n${JAVA_VIZ_HARNESS}`;
    const added = addMainMethod(demoted, demotedMask, runCall);
    if (added) return `${added}\n${JAVA_VIZ_HARNESS}`;
    throw new Error('This Java file defines a Main class, but the harness could not find its main() method - add a public static void main(String[] args) method to Main, or move the entry method to a Solution class.');
  }
  // No Main yet: append the harness and a Main that calls it.
  return `${demoted}\n${JAVA_VIZ_HARNESS}\n\n// ---- visualize this test case (auto-generated) ----\npublic class Main {\n    public static void main(String[] argv) {\n        ${runCall}\n    }\n}\n`;
}

export function buildCaseVisualization(ext, code, entry, args) {
  const parsed = parseEntry(entry);
  if (!parsed) {
    throw new Error(`"${entry}" is not a valid function/method name.`);
  }
  if (ext === 'py') return pythonHarness(code, parsed.method, args);
  if (ext === 'js') return jsHarness(code, parsed.method, args);
  // A bare entry passes className null: the Java harness resolves
  // the entry class itself (entry's class part, else Solution if
  // declared, else the file's public class, else Solution), the
  // same resolution the test runner uses.
  if (ext === 'java') return javaHarness(code, parsed.method, args, parsed.className);
  throw new Error(`Visualizing a case is not supported for .${ext} files yet (Python, JavaScript and Java are).`);
}
