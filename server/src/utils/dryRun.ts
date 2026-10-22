import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { PY_LAUNCHER_SOURCE } from 'utils/pyLauncher';
import { ensureJavaLibrary, execFileChecked, javaClasspath } from 'utils/javaLibrary';

// Dry runs for the AI assistant: before a proposal that uses the
// tracer library is handed to the user, actually execute it with
// the same machinery a Build uses (Python launcher, the vendored
// JS library, javac + the Java library) and report whether it
// produced a visualization. Models keep writing code that cannot
// run - a missing import, an undefined tracer variable, a Solution
// class nothing ever calls - and a syntax check catches none of
// that; a real run catches all of it, and its error becomes the
// repair prompt. This executes the user's own code locally, like
// the tracers and the test runner - never expose it publicly.

export interface DryRunResult {
  ok: boolean,
  error?: string,
}

const PY_LIBRARY_DIR = path.resolve(__dirname, '..', '..', '..', 'tracers.py', 'src');
const JS_UMD_PATH = path.resolve(__dirname, '..', 'tracers', 'js', 'algorithm-visualizer.umd.js');

const NO_VISUALIZATION = {
  py: 'The code ran without errors but produced no visualization - nothing called the tracers. If the file only defines a class or functions, add a driver section at the end that creates the tracers, sets the layout root (Layout.set_root) and calls the code.',
  js: 'The code ran without errors but produced no visualization - nothing called the tracers. If the file only defines a class or functions, add a driver section at the end that creates the tracers, sets the layout root (Layout.setRoot) and calls the code.',
  java: 'The code ran without errors but produced no visualization - nothing called the tracers. Make sure the code creates tracers, sets the layout root once (Layout.setRoot) and calls delay() as it runs.',
};

function tail(text: string, max = 1500): string {
  const trimmed = (text || '').trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

function exec(cmd: string, args: string[], timeout: number, cwd: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, cwd, env }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = (error as any).killed || (error as any).signal === 'SIGTERM';
        reject(new Error(timedOut ? `Timed out after ${Math.round(timeout / 1000)}s` : (tail((stderr || '').toString()) || error.message)));
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

async function commandsIn(dir: string): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'visualization.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch (error) {
    return 0;
  }
}

async function dryRunPython(code: string): Promise<DryRunResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-dryrun-py-'));
  try {
    await fs.writeFile(path.join(dir, 'Main.py'), code);
    await fs.writeFile(path.join(dir, '_launcher.py'), PY_LAUNCHER_SOURCE);
    await exec(process.env.PYTHON_BIN || 'python3', ['_launcher.py'], 10000, dir, {
      ...process.env,
      ALGORITHM_VISUALIZER: '1',
      PYTHONPATH: PY_LIBRARY_DIR,
    });
    return (await commandsIn(dir)) > 0 ? { ok: true } : { ok: false, error: NO_VISUALIZATION.py };
  } catch (error) {
    return { ok: false, error: tail((error as Error).message) };
  } finally {
    await fs.remove(dir).catch(() => undefined);
  }
}

// The JS harness mirrors the browser worker exactly (same delay()
// line rewriting, same conditional force-import), against the
// vendored copy of the same UMD build the worker loads.
const JS_HARNESS = `
const fs = require('fs');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return { get: () => Promise.reject(new Error('offline in dry run')), post: () => Promise.reject(new Error('offline in dry run')) };
  if (request === 'opn') return () => Promise.resolve();
  return originalLoad.apply(this, arguments);
};
const AV = require(process.argv[3]);
const raw = fs.readFileSync(process.argv[2], 'utf8');
const lines = raw.split('\\n').map((line, i) => line.replace(/(\\.\\s*delay\\s*)\\(\\s*\\)/g, '$1(' + i + ')'));
let code = lines.join('\\n');
if (!/require\\(\\s*['"]algorithm-visualizer['"]\\s*\\)/.test(raw)) {
  code = 'const { Tracer, Array1DTracer, Array2DTracer, ChartTracer, GraphTracer, LogTracer, Layout, VerticalLayout, HorizontalLayout, Randomize } = require(\\'algorithm-visualizer\\');\\n' + code;
}
const fakeRequire = name => ({ 'algorithm-visualizer': AV }[name]);
try {
  (function () { const require = fakeRequire; eval(code); })();
} catch (error) {
  console.log('__DRYRUN__ ' + JSON.stringify({ ok: false, error: String((error && error.stack) || error) }));
  process.exit(0);
}
const count = (AV.Commander && AV.Commander.commands || []).length;
console.log('__DRYRUN__ ' + JSON.stringify(count > 0 ? { ok: true } : { ok: false, error: 'NO_VISUALIZATION' }));
process.exit(0);
`;

async function dryRunJavaScript(code: string): Promise<DryRunResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-dryrun-js-'));
  try {
    const codePath = path.join(dir, 'code.js');
    const harnessPath = path.join(dir, 'harness.js');
    await fs.writeFile(codePath, code);
    await fs.writeFile(harnessPath, JS_HARNESS);
    const { stdout } = await exec(process.execPath, [harnessPath, codePath, JS_UMD_PATH], 10000, dir);
    const line = stdout.split('\n').find(l => l.startsWith('__DRYRUN__ '));
    if (!line) return { ok: false, error: 'The JavaScript dry run produced no result (it may have crashed).' };
    const result = JSON.parse(line.slice('__DRYRUN__ '.length));
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error === 'NO_VISUALIZATION' ? NO_VISUALIZATION.js : tail(result.error || 'The visualization run failed.') };
  } catch (error) {
    return { ok: false, error: tail((error as Error).message) };
  } finally {
    await fs.remove(dir).catch(() => undefined);
  }
}

async function dryRunJava(code: string): Promise<DryRunResult> {
  if (!/\bclass\s+Main\b/.test(code || '')) {
    return { ok: false, error: 'This Java file defines no Main class, so there is nothing to run: Java visualizations run as Main.java (class Main) with a public static void main that creates the tracers, sets the layout root once and calls the code. A file that only defines class Solution has no entry point - exercise it from the Testcase panel, or add a Main driver.' };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-dryrun-java-'));
  try {
    await fs.writeFile(path.join(dir, 'Main.java'), code);
    await ensureJavaLibrary();
    await execFileChecked(
      process.env.JAVAC_BIN || 'javac',
      ['-cp', javaClasspath(), '-d', dir, path.join(dir, 'Main.java')],
      { timeout: 30000 },
      'Java compiler (javac) not found. Install a JDK and make sure javac is on the PATH, or set JAVAC_BIN.',
    );
    await execFileChecked(
      process.env.JAVA_BIN || 'java',
      ['-cp', javaClasspath(dir), 'Main'],
      { cwd: dir, env: { ...process.env, ALGORITHM_VISUALIZER: '1' }, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      'Java runtime (java) not found. Install a JDK/JRE and make sure java is on the PATH, or set JAVA_BIN.',
    );
    return (await commandsIn(dir)) > 0 ? { ok: true } : { ok: false, error: NO_VISUALIZATION.java };
  } catch (error) {
    return { ok: false, error: tail((error as Error).message) };
  } finally {
    await fs.remove(dir).catch(() => undefined);
  }
}

export async function dryRunVisualization(language: string, code: string): Promise<DryRunResult> {
  if (language === 'py') return dryRunPython(code);
  if (language === 'js') return dryRunJavaScript(code);
  if (language === 'java') return dryRunJava(code);
  return { ok: true };
}
