import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { codesDir } from 'config/paths';

// LeetCode-style test runs for a code pad: the user's code plus a set
// of cases ({args, expected}) are handed to a small per-language
// driver, which resolves the entry point (a Solution class method,
// or a top-level function of the same name), calls it once per case
// with JSON-decoded arguments, and compares the JSON-normalized
// return value against the expected one. Visualization libraries are
// stubbed with no-ops, so an instrumented pad can be tested as-is;
// the stubs are best-effort (Randomize returns zero-filled data).
//
// This executes the user's own code locally, exactly like the
// tracers do - never expose it beyond the local/intranet use the
// rest of the server assumes.

export interface TestCaseSpec {
  name: string;
  args: any[];
  expected: any;
}

export interface TestResult {
  name: string;
  pass: boolean;
  actual: any;
  expected: any;
  error: string | null;
  stdout: string;
}

const ENTRY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function exec(cmd: string, args: string[], timeout: number, cwd?: string): Promise<{ stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = (error as any).killed || (error as any).signal === 'SIGTERM';
        const detail = (stderr || '').toString().trim();
        reject(new Error(timedOut ? `Timed out after ${Math.round(timeout / 1000)}s` : (detail ? detail.slice(-3000) : error.message)));
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

function parseResults(stdout: string, cases: TestCaseSpec[]): TestResult[] {
  const line = stdout.split('\n').find(l => l.startsWith('__RESULTS__ '));
  if (!line) throw new Error('The test driver produced no results (it may have crashed).');
  const raw = JSON.parse(line.slice('__RESULTS__ '.length));
  return cases.map((tc, i) => {
    const r = raw[i] || {};
    return {
      name: tc.name,
      pass: !!r.pass,
      actual: r.actual === undefined ? null : r.actual,
      expected: tc.expected,
      error: r.error || null,
      stdout: r.stdout || '',
    };
  });
}

const PY_STUB = `
class _Meta(type):
    def __getattr__(cls, name):
        return lambda *a, **k: _Dummy()


class _Dummy(metaclass=_Meta):
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        return lambda *a, **k: self


class _Randomize:
    @staticmethod
    def array1d(size=0, *a, **k):
        return [0] * (size or 0)

    @staticmethod
    def array2d(rows=0, cols=0, *a, **k):
        return [[0] * (cols or 0) for _ in range(rows or 0)]

    def __getattr__(self, name):
        return lambda *a, **k: 0


Tracer = _Dummy
Array1DTracer = _Dummy
Array2DTracer = _Dummy
ChartTracer = _Dummy
GraphTracer = _Dummy
LogTracer = _Dummy
Layout = _Dummy
VerticalLayout = _Dummy
HorizontalLayout = _Dummy
Randomize = _Randomize()
`;

const PY_DRIVER = `
import sys, os, json, io, traceback
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def normalize(v):
    if isinstance(v, tuple):
        return [normalize(x) for x in v]
    if isinstance(v, list):
        return [normalize(x) for x in v]
    if isinstance(v, dict):
        return {str(k): normalize(x) for k, x in v.items()}
    if isinstance(v, (set, frozenset)):
        return sorted((normalize(x) for x in v), key=repr)
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return repr(v)


def main():
    with open(sys.argv[1], 'r') as f:
        spec = json.load(f)
    entry = spec['entry']
    target = None
    load_error = None
    try:
        import importlib.util
        module_spec = importlib.util.spec_from_file_location('solution', sys.argv[2])
        module = importlib.util.module_from_spec(module_spec)
        with redirect_stdout(io.StringIO()):
            module_spec.loader.exec_module(module)
        solution_cls = getattr(module, 'Solution', None)
        if solution_cls is not None and hasattr(solution_cls, entry):
            target = getattr(solution_cls(), entry)
        elif hasattr(module, entry):
            target = getattr(module, entry)
        else:
            load_error = 'No method %s found (looked for a Solution class method and a top-level function)' % entry
    except Exception:
        load_error = traceback.format_exc(limit=3)
    results = []
    for case in spec['cases']:
        result = {'name': case.get('name', 'Case'), 'pass': False, 'actual': None, 'error': None, 'stdout': ''}
        if load_error is not None:
            result['error'] = load_error
            results.append(result)
            continue
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                value = target(*case.get('args', []))
            result['actual'] = normalize(value)
            result['pass'] = result['actual'] == case.get('expected')
        except Exception:
            result['error'] = traceback.format_exc(limit=3)
        result['stdout'] = buf.getvalue()
        results.append(result)
    print('__RESULTS__ ' + json.dumps(results))


main()
`;

const JS_STUB = `
function makeInstance() {
  return new Proxy({}, {
    get: function (t, prop) {
      if (prop === Symbol.toPrimitive) return function () { return 0; };
      return function () { return makeInstance(); };
    },
  });
}
function makeClass() {
  const cls = class {};
  return new Proxy(cls, {
    get: function (t, prop) {
      if (prop in t) return t[prop];
      return function () { return makeInstance(); };
    },
    construct: function () { return makeInstance(); },
  });
}
const Randomize = {
  array1d: function (size) { return Array.from({ length: size || 0 }, function () { return 0; }); },
  array2d: function (rows, cols) {
    return Array.from({ length: rows || 0 }, function () {
      return Array.from({ length: cols || 0 }, function () { return 0; });
    });
  },
};
const base = {};
['Tracer', 'Array1DTracer', 'Array2DTracer', 'ChartTracer', 'GraphTracer', 'LogTracer',
 'Layout', 'VerticalLayout', 'HorizontalLayout'].forEach(function (name) { base[name] = makeClass(); });
base.Randomize = Randomize;
module.exports = new Proxy(base, {
  get: function (t, prop) {
    if (prop in t) return t[prop];
    return makeClass();
  },
});
`;

const JS_DRIVER = `
const fs = require('fs');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const code = fs.readFileSync(process.argv[3], 'utf8');

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return deepEqual(a[k], b[k]); });
  }
  return false;
}

async function main() {
  let call = null;
  let loadError = null;
  try {
    const resolved = eval(code + '\\n;(function () {'
      + ' var S; try { S = Solution; } catch (e) {}'
      + ' var F; try { F = ' + spec.entry + '; } catch (e) {}'
      + ' return { S: S, F: F };'
      + '})()');
    if (typeof resolved.S === 'function' && resolved.S.prototype
        && typeof resolved.S.prototype[spec.entry] === 'function') {
      const instance = new resolved.S();
      call = function (args) { return instance[spec.entry].apply(instance, args); };
    } else if (typeof resolved.F === 'function') {
      call = function (args) { return resolved.F.apply(null, args); };
    } else {
      loadError = 'No function ' + spec.entry + ' found (looked for a Solution class method and a top-level function)';
    }
  } catch (e) {
    loadError = String((e && e.stack) || e);
  }
  const results = [];
  for (const tc of spec.cases) {
    const r = { name: tc.name || 'Case', pass: false, actual: null, error: null, stdout: '' };
    if (loadError) {
      r.error = loadError;
      results.push(r);
      continue;
    }
    const logs = [];
    const oldLog = console.log;
    console.log = function () {
      logs.push(Array.from(arguments).map(function (a) { return String(a); }).join(' '));
    };
    try {
      let value = call(tc.args || []);
      if (value && typeof value.then === 'function') value = await value;
      if (value === undefined) throw new Error('The function returned undefined');
      r.actual = JSON.parse(JSON.stringify(value));
      r.pass = deepEqual(r.actual, tc.expected);
    } catch (e) {
      r.error = String((e && e.stack) || e);
    } finally {
      console.log = oldLog;
    }
    r.stdout = logs.join('\\n');
    results.push(r);
  }
  process.stdout.write('__RESULTS__ ' + JSON.stringify(results) + '\\n');
}

main();
`;

const JAVA_DRIVER = `
import com.google.gson.*;
import java.io.*;
import java.lang.reflect.*;
import java.math.BigDecimal;
import java.nio.file.*;
import java.util.*;

public class Driver {
  static final Gson gson = new Gson();

  public static void main(String[] argv) throws Exception {
    String specText = new String(Files.readAllBytes(Paths.get(argv[0])), "UTF-8");
    JsonObject spec = gson.fromJson(specText, JsonObject.class);
    String entry = spec.get("entry").getAsString();
    JsonArray cases = spec.getAsJsonArray("cases");

    Class<?> solutionClass = null;
    Object instance = null;
    String loadError = null;
    try {
      solutionClass = Class.forName("Solution");
      Constructor<?> ctor = solutionClass.getDeclaredConstructor();
      ctor.setAccessible(true);
      instance = ctor.newInstance();
    } catch (Throwable t) {
      loadError = "No usable class Solution found (" + t.getClass().getSimpleName()
        + (t.getMessage() != null ? ": " + t.getMessage() : "") + ")";
    }

    JsonArray results = new JsonArray();
    Method method = null;
    for (JsonElement caseEl : cases) {
      JsonObject tc = caseEl.getAsJsonObject();
      JsonObject r = new JsonObject();
      r.addProperty("name", tc.get("name").getAsString());
      JsonArray args = tc.getAsJsonArray("args");
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      try {
        if (loadError != null) throw new RuntimeException(loadError);
        if (method == null || method.getParameterCount() != args.size()) {
          method = findMethod(solutionClass, entry, args.size());
          if (method == null) {
            throw new RuntimeException("No method " + entry + " taking " + args.size()
              + " argument(s) on class Solution");
          }
          method.setAccessible(true);
        }
        Class<?>[] types = method.getParameterTypes();
        Object[] javaArgs = new Object[args.size()];
        for (int i = 0; i < args.size(); i++) javaArgs[i] = convert(args.get(i), types[i]);
        PrintStream oldOut = System.out;
        System.setOut(new PrintStream(buf, true, "UTF-8"));
        Object result;
        try {
          result = method.invoke(instance, javaArgs);
        } finally {
          System.setOut(oldOut);
        }
        JsonElement actual = gson.toJsonTree(result);
        r.add("actual", actual);
        r.addProperty("pass", jsonEquals(actual, tc.get("expected")));
        r.add("error", JsonNull.INSTANCE);
      } catch (Throwable t) {
        r.add("actual", JsonNull.INSTANCE);
        r.addProperty("pass", false);
        Throwable cause = (t instanceof InvocationTargetException && t.getCause() != null) ? t.getCause() : t;
        r.addProperty("error", cause.getClass().getSimpleName() + ": " + String.valueOf(cause.getMessage()));
      }
      r.addProperty("stdout", buf.toString("UTF-8"));
      results.add(r);
    }
    System.out.println("__RESULTS__ " + gson.toJson(results));
  }

  static Method findMethod(Class<?> cls, String name, int argc) {
    for (Method m : cls.getDeclaredMethods()) {
      if (m.getName().equals(name) && m.getParameterCount() == argc && !m.isBridge()) return m;
    }
    return null;
  }

  static boolean jsonEquals(JsonElement a, JsonElement b) {
    if (a == null || b == null) return a == b;
    if (a.isJsonPrimitive() && b.isJsonPrimitive()
        && a.getAsJsonPrimitive().isNumber() && b.getAsJsonPrimitive().isNumber()) {
      return new BigDecimal(a.getAsString()).compareTo(new BigDecimal(b.getAsString())) == 0;
    }
    return a.equals(b);
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
    if (t == byte.class || t == Byte.class) return e.getAsByte();
    if (t == short.class || t == Short.class) return e.getAsShort();
    if (t.isArray()) {
      JsonArray arr = e.getAsJsonArray();
      Class<?> comp = t.getComponentType();
      Object out = Array.newInstance(comp, arr.size());
      for (int i = 0; i < arr.size(); i++) Array.set(out, i, convert(arr.get(i), comp));
      return out;
    }
    if (List.class.isAssignableFrom(t)) {
      List<Object> out = new ArrayList<>();
      for (JsonElement item : e.getAsJsonArray()) out.add(gson.fromJson(item, Object.class));
      return out;
    }
    if (t == Object.class) return gson.fromJson(e, Object.class);
    throw new RuntimeException("Unsupported argument type: " + t.getName());
  }
}
`;

export async function runTests(
  language: string,
  code: string,
  entry: string,
  cases: TestCaseSpec[],
): Promise<{ results: TestResult[], durationMs: number }> {
  if (!ENTRY_PATTERN.test(entry)) {
    throw new Error(`"${entry}" is not a valid function/method name.`);
  }
  const startedAt = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-tests-'));
  try {
    const specPath = path.join(dir, 'spec.json');
    await fs.writeFile(specPath, JSON.stringify({ entry, cases }));
    let stdout: string;
    if (language === 'py') {
      await fs.writeFile(path.join(dir, 'algorithm_visualizer.py'), PY_STUB);
      await fs.writeFile(path.join(dir, 'solution.py'), code);
      await fs.writeFile(path.join(dir, 'driver.py'), PY_DRIVER);
      ({ stdout } = await exec(
        process.env.PYTHON_BIN || 'python3',
        [path.join(dir, 'driver.py'), specPath, path.join(dir, 'solution.py')],
        10000, dir,
      ));
    } else if (language === 'js') {
      const stubDir = path.join(dir, 'node_modules', 'algorithm-visualizer');
      await fs.mkdirp(stubDir);
      await fs.writeFile(path.join(stubDir, 'package.json'), '{"name":"algorithm-visualizer","main":"index.js"}');
      await fs.writeFile(path.join(stubDir, 'index.js'), JS_STUB);
      await fs.writeFile(path.join(dir, 'code.js'), code);
      await fs.writeFile(path.join(dir, 'driver.js'), JS_DRIVER);
      ({ stdout } = await exec(
        process.execPath,
        [path.join(dir, 'driver.js'), specPath, path.join(dir, 'code.js')],
        10000, dir,
      ));
    } else if (language === 'java') {
      await fs.writeFile(path.join(dir, 'Solution.java'), code);
      await fs.writeFile(path.join(dir, 'Driver.java'), JAVA_DRIVER);
      const gsonJar = path.resolve(__dirname, '..', 'tracers', 'java', 'lib', 'gson-2.8.5.jar');
      const classesDir = path.resolve(codesDir, '.tracers-java-classes');
      const cpEntries = [gsonJar];
      if (await fs.pathExists(classesDir)) cpEntries.push(classesDir);
      const cp = cpEntries.join(path.delimiter);
      try {
        await exec(
          process.env.JAVAC_BIN || 'javac',
          ['-cp', cp, '-d', dir, path.join(dir, 'Solution.java'), path.join(dir, 'Driver.java')],
          30000, dir,
        );
      } catch (error) {
        if (/ENOENT/.test((error as Error).message)) {
          throw new Error('Java compiler (javac) not found. Install a JDK and make sure javac is on the PATH, or set JAVAC_BIN.');
        }
        const hint = /algorithm_visualizer/.test((error as Error).message)
          ? '\n(The code imports the visualization library, whose classes are compiled on the first Java visualization run - run the pad once, or remove the tracer imports for testing.)'
          : '';
        throw new Error(`Java compilation failed:\n${(error as Error).message}${hint}`);
      }
      ({ stdout } = await exec(
        process.env.JAVA_BIN || 'java',
        ['-cp', [dir, cp].join(path.delimiter), 'Driver', specPath],
        15000, dir,
      ));
    } else {
      throw new Error(`Test cases are not supported for ".${language}" files yet (Python, JavaScript and Java are).`);
    }
    return { results: parseResults(stdout, cases), durationMs: Date.now() - startedAt };
  } finally {
    await fs.remove(dir).catch(() => undefined);
  }
}
