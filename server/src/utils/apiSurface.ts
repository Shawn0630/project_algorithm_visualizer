import fs from 'fs';
import path from 'path';
import child_process from 'child_process';

// Static validation of tracer-API usage in AI proposals, against
// the REAL library surface of this app - the layer that catches
// what a prompt cannot: the model had the reference in front of
// it and still called Array2DTracer's 4-argument select on an
// Array1DTracer, or invented a method outright. A dry run cannot
// catch semantic misuse that still compiles, so the calls are
// checked here, exactly:
//
//   - the surface comes from the library sources themselves:
//     Java parsed from tracers.java, Python parsed from
//     tracers.py (with snake_case/camelCase twins, since the
//     Python lib accepts both), JavaScript introspected from the
//     vendored UMD in a child process (method existence only -
//     the transpiled lib's declared arities are not reliable).
//   - a variable's class is tracked from its assignment
//     (Java declarations, `x = new C(...)`, `x = C(...)`), and
//     every `var.method(args)` on a known-class variable is
//     checked for existence and, where signatures are known,
//     argument count. Unknown variables (the user's own objects)
//     are never flagged - the validator is deliberately
//     conservative so it only speaks when it is sure.
//   - invented tracer classes (new FooTracer) and duplicated
//     import lines are flagged too.

type MethodArities = Map<string, Set<number>>;
interface ClassInfo { bases: string[]; methods: MethodArities }

const TRACER_CLASSES = ['Array1DTracer', 'Array2DTracer', 'ChartTracer', 'GraphTracer', 'LogTracer'];
const ALL_CLASSES = [...TRACER_CLASSES, 'Tracer', 'Layout', 'VerticalLayout', 'HorizontalLayout', 'Commander'];
const BUILDER_METHODS = new Set(['create', 'sorted', 'directed', 'weighted']);

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function mergeInto(target: MethodArities, name: string, arity: number) {
  if (!target.has(name)) target.set(name, new Set());
  target.get(name)!.add(arity);
}

// ---------- Java surface (parsed from tracers.java) ----------
let javaSurface: Map<string, ClassInfo> | null = null;
function getJavaSurface(): Map<string, ClassInfo> {
  if (javaSurface) return javaSurface;
  const surface = new Map<string, ClassInfo>();
  const dir = path.resolve(repoRoot, 'tracers.java', 'src', 'main', 'java', 'org', 'algorithm_visualizer');
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.java')) continue;
      const src = fs.readFileSync(path.resolve(dir, file), 'utf8');
      const classMatch = src.match(/class\s+(\w+)(?:\s+extends\s+(\w+))?/);
      if (!classMatch) continue;
      const methods: MethodArities = new Map();
      const re = /public\s+(?:static\s+)?[\w<>\[\],.? ]+?\s+(\w+)\s*\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const params = m[2].trim();
        mergeInto(methods, m[1], params === '' ? 0 : params.split(',').length);
      }
      surface.set(classMatch[1], { bases: classMatch[2] ? [classMatch[2]] : [], methods });
    }
  } catch (error) {
    // Library missing: validation degrades to "no opinion".
  }
  javaSurface = surface;
  return surface;
}

// ---------- Python surface (parsed from tracers.py) ----------
let pySurface: Map<string, ClassInfo> | null = null;
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const camelToSnake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
function getPySurface(): Map<string, ClassInfo> {
  if (pySurface) return pySurface;
  const surface = new Map<string, ClassInfo>();
  try {
    const src = fs.readFileSync(path.resolve(repoRoot, 'tracers.py', 'src', 'algorithm_visualizer', '__init__.py'), 'utf8');
    const lines = src.split('\n');
    let current: ClassInfo | null = null;
    for (const line of lines) {
      const classMatch = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        current = {
          bases: (classMatch[2] || '').split(',').map(b => b.trim()).filter(b => ALL_CLASSES.includes(b)),
          methods: new Map(),
        };
        surface.set(classMatch[1], current);
        continue;
      }
      if (/^\S/.test(line)) current = null;
      const defMatch = line.match(/^\s+def\s+(\w+)\s*\(([^)]*)\)/);
      if (current && defMatch && !defMatch[1].startsWith('__')) {
        const params = defMatch[2].split(',').map(p => p.trim()).filter(p => p && p !== 'self' && p !== 'cls');
        const required = params.filter(p => !p.includes('=') && !p.startsWith('*')).length;
        // Register every arity in required..total (defaults), plus
        // the camelCase/snake_case twin the lib also accepts.
        for (const name of [defMatch[1], snakeToCamel(defMatch[1]), camelToSnake(defMatch[1])]) {
          for (let a = required; a <= params.length; a++) mergeInto(current.methods, name, a);
        }
      }
    }
  } catch (error) {
    // Library missing: no opinion.
  }
  pySurface = surface;
  return surface;
}

// ---------- JavaScript surface (introspected from the UMD) ----------
let jsSurfacePromise: Promise<Map<string, ClassInfo>> | null = null;
function getJsSurface(): Promise<Map<string, ClassInfo>> {
  if (jsSurfacePromise) return jsSurfacePromise;
  jsSurfacePromise = new Promise(resolve => {
    const surface = new Map<string, ClassInfo>();
    const script = `
const Module = require('module');
const orig = Module._load;
Module._load = function (id, ...rest) {
  if (id === 'axios') return { get: () => Promise.reject(new Error('x')), post: () => Promise.reject(new Error('x')) };
  if (id === 'opn') return () => Promise.resolve();
  return orig.call(this, id, ...rest);
};
try {
  const lib = require(process.argv[1]);
  const out = {};
  for (const name of Object.keys(lib)) {
    const cls = lib[name];
    if (typeof cls !== 'function' || !cls.prototype) continue;
    const methods = new Set();
    let proto = cls.prototype;
    while (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key !== 'constructor' && typeof proto[key] === 'function') methods.add(key);
      }
      proto = Object.getPrototypeOf(proto);
    }
    out[name] = [...methods];
  }
  console.log(JSON.stringify(out));
} catch (e) {
  console.log('{}');
}
process.exit(0);
`;
    try {
      child_process.execFile(process.execPath, ['-e', script, path.resolve(__dirname, '..', 'tracers', 'js', 'algorithm-visualizer.umd.js')], {
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout) => {
        try {
          const parsed = JSON.parse(String(stdout).trim() || '{}');
          for (const [name, methods] of Object.entries(parsed)) {
            const map: MethodArities = new Map();
            (methods as string[]).forEach(method => mergeInto(map, method, -1));
            surface.set(name, { bases: [], methods: map });
          }
        } catch (parseError) {
          // No surface: no opinion.
        }
        resolve(surface);
      });
    } catch (error) {
      resolve(surface);
    }
  });
  return jsSurfacePromise;
}

function resolvedMethods(surface: Map<string, ClassInfo>, className: string, seen = new Set<string>()): MethodArities {
  const out: MethodArities = new Map();
  if (seen.has(className)) return out;
  seen.add(className);
  const info = surface.get(className);
  if (!info) return out;
  info.methods.forEach((arities, name) => arities.forEach(a => mergeInto(out, name, a)));
  info.bases.forEach(base => {
    resolvedMethods(surface, base, seen).forEach((arities, name) => arities.forEach(a => mergeInto(out, name, a)));
  });
  return out;
}

// Calls in the code: var.method(args) with the arg string captured
// by paren matching (one level of nesting is handled by depth).
function extractCalls(code: string): { obj: string, method: string, arity: number, text: string }[] {
  const calls: { obj: string, method: string, arity: number, text: string }[] = [];
  const re = /([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    let commas = 0;
    let hasContent = false;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 1) commas++;
      if (depth >= 1 && !/\s/.test(ch)) hasContent = true;
      i++;
    }
    calls.push({
      obj: m[1],
      method: m[2],
      arity: hasContent ? commas + 1 : 0,
      text: `${m[1]}.${m[2]}(...)`,
    });
  }
  return calls;
}

function variableClasses(language: string, code: string): Map<string, string> {
  const vars = new Map<string, string>();
  const classAlt = ALL_CLASSES.join('|');
  if (language === 'java') {
    const decl = new RegExp(`\\b(${classAlt})\\s+(\\w+)\\s*(?:=|;|,)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = decl.exec(code))) vars.set(m[2], m[1]);
  }
  const assign = new RegExp(`(\\w+)\\s*=\\s*new\\s+(${classAlt})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = assign.exec(code))) vars.set(m[1], m[2]);
  if (language === 'py') {
    const pyAssign = new RegExp(`(\\w+)\\s*=\\s*(${classAlt})\\s*\\(`, 'g');
    while ((m = pyAssign.exec(code))) vars.set(m[1], m[2]);
  }
  return vars;
}

function duplicateImports(language: string, code: string): string[] {
  const lines = code.split('\n').map(l => l.trim()).filter(l =>
    language === 'java' ? /^import\s/.test(l) :
    language === 'py' ? /^(import\s|from\s)/.test(l) :
    /require\(/.test(l));
  const seen = new Map<string, number>();
  lines.forEach(l => seen.set(l, (seen.get(l) || 0) + 1));
  return [...seen.entries()].filter(([, n]) => n > 1).map(([l]) => `duplicated import line: ${l}`);
}

export async function validateApiUsage(language: string, code: string): Promise<string[]> {
  const surface = language === 'java' ? getJavaSurface() : language === 'py' ? getPySurface() : await getJsSurface();
  if (!surface.size) return [];
  const violations: string[] = [];
  const vars = variableClasses(language, code);
  // Randomize builder variables: their methods are the builder set.
  const builderRe = /(\w+)\s*=\s*new\s+Randomize\.\w+\s*\(|(\w+)\s*=\s*Randomize\.\w+\s*\(/g;
  let bm: RegExpExecArray | null;
  const builders = new Set<string>();
  while ((bm = builderRe.exec(code))) builders.add(bm[1] || bm[2]);

  for (const call of extractCalls(code)) {
    if (call.method === 'delay') continue;
    // Static-style call on a class name itself (Tracer.delay,
    // Layout.setRoot / Layout.set_root).
    const className = ALL_CLASSES.includes(call.obj) ? call.obj : vars.get(call.obj);
    if (!className) {
      if (builders.has(call.obj) && !BUILDER_METHODS.has(call.method)) {
        violations.push(`${call.text} - Randomize builders only have create / sorted / directed / weighted; ${call.method} does not exist on them`);
      }
      continue;
    }
    const methods = resolvedMethods(surface, className);
    if (!methods.size) continue;
    if (!methods.has(call.method)) {
      violations.push(`${call.text} - ${className} has no method "${call.method}" in this app's tracer library`);
      continue;
    }
    if (language !== 'js') {
      const arities = methods.get(call.method)!;
      if (!arities.has(call.arity)) {
        violations.push(`${call.text} - ${className}.${call.method} takes ${[...arities].sort((a, b) => a - b).join(' or ')} argument(s), not ${call.arity}`);
        continue;
      }
    }
    // The 2-D idiom used on a 1-D view: Array1DTracer INHERITS
    // the grid forms from Array2DTracer in this library, so a
    // 4-argument select or a selectRow on it compiles and runs -
    // it just silently treats the row as a grid, which is never
    // what the code means. Flag it as the misuse it is.
    if ((className === 'Array1DTracer' || className === 'ChartTracer')
      && (['select', 'deselect', 'patch', 'depatch'].includes(call.method) && call.arity >= 3
        || ['selectRow', 'selectCol', 'deselectRow', 'deselectCol'].includes(call.method))) {
      violations.push(`${call.text} - the multi-argument / row-column form is Array2DTracer's grid API; on a ${className} it silently treats the 1-D view as a grid. For a 1-D view use ${call.method}(x) or ${call.method}(sx, ex)`);
    }
  }

  // Tracer variables initialized to None / null - the classic
  // placeholder pattern: the algorithm's methods call
  // array_tracer.select(...), but the variable is never actually
  // assigned a tracer anywhere in the file, so the run dies with
  // "'NoneType' object has no attribute 'select'". (A variable
  // that IS assigned a tracer instance somewhere - the map above
  // found it - is not flagged; ordering/scope slips beyond that
  // are the dry run's job.)
  const noneInit = /(\w+)\s*=\s*(?:None|null)\b/g;
  let nm: RegExpExecArray | null;
  const noneVars = new Set<string>();
  while ((nm = noneInit.exec(code))) {
    if (!vars.has(nm[1]) && new RegExp(`${nm[1]}\\s*\\.`).test(code)) noneVars.add(nm[1]);
  }
  noneVars.forEach(name => violations.push(`${name} - this tracer variable is initialized to ${language === 'py' ? 'None' : 'null'} and never assigned a tracer, but methods are called on it; create the tracer before any code that uses it runs`));

  // Invented tracer classes.
  const construction = /(?:new\s+|=\s*)([A-Z]\w*Tracer)\s*\(/g;
  let cm: RegExpExecArray | null;
  const invented = new Set<string>();
  while ((cm = construction.exec(code))) {
    if (!ALL_CLASSES.includes(cm[1]) && !new RegExp(`class\\s+${cm[1]}\\b`).test(code)) invented.add(cm[1]);
  }
  invented.forEach(name => violations.push(`${name} - there is no tracer class named ${name} in this app's library`));

  violations.push(...duplicateImports(language, code));
  return [...new Set(violations)].slice(0, 12);
}
