import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codesDir } from 'config/paths';

export interface SyntaxResult {
  ok: boolean;
  error: string;
}

// Best-effort syntax/compile check of AI-proposed code BEFORE the user
// is asked to accept it, so a proposal that does not even compile is
// labelled as such. Returns null when no cheap check exists for the
// language (C++ would need the Docker build) or the checker itself is
// unavailable - null means "not checked", never "broken".
const libraryClassesDir = path.resolve(codesDir, '.tracers-java-classes');
const gsonJar = path.resolve(__dirname, '..', 'tracers', 'java', 'lib', 'gson-2.8.5.jar');

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number, stderr: string }> {
  return new Promise(resolve => {
    execFile(command, args, {timeout: timeoutMs}, (error: any, stdout, stderr) => {
      resolve({code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr: String(stderr || (error ? error.message : ''))});
    });
  });
}

export async function checkSyntax(language: string, code: string): Promise<SyntaxResult | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-syntax-'));
  try {
    if (language === 'py') {
      const file = path.join(dir, 'Main.py');
      fs.writeFileSync(file, code);
      const {code: exit, stderr} = await run(process.env.PYTHON_BIN || 'python3', ['-m', 'py_compile', file], 10000);
      return {ok: exit === 0, error: stderr.trim().split('\n').slice(0, 5).join('\n')};
    }
    if (language === 'js') {
      const file = path.join(dir, 'Main.js');
      fs.writeFileSync(file, code);
      // node --check parses without executing, so unresolved requires
      // in the visualizer boilerplate do not matter.
      const {code: exit, stderr} = await run(process.execPath, ['--check', file], 10000);
      return {ok: exit === 0, error: stderr.trim().split('\n').slice(0, 5).join('\n')};
    }
    if (language === 'java') {
      // Needs the tracer library compiled (the Java tracer builds it on
      // first use); without it every file would falsely "fail".
      if (!fs.existsSync(libraryClassesDir) || !fs.existsSync(gsonJar)) return null;
      const file = path.join(dir, 'Main.java');
      fs.writeFileSync(file, code);
      const javac = process.env.JAVAC_BIN || 'javac';
      const {code: exit, stderr} = await run(javac, ['-cp', [libraryClassesDir, gsonJar].join(path.delimiter), '-d', path.join(dir, 'out'), file], 20000);
      return {ok: exit === 0, error: stderr.trim().split('\n').slice(0, 8).join('\n')};
    }
    return null;
  } catch (error) {
    return null;
  } finally {
    try {
      (fs.rmdirSync as any)(dir, {recursive: true});
    } catch (error) {
      // best effort cleanup
    }
  }
}
