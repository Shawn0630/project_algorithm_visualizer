import path from 'path';
import child_process from 'child_process';
import { Release, Tracer } from 'tracers/Tracer';
import express from 'express';
import uuid from 'uuid';
import fs from 'fs-extra';
import { timeLimit } from 'config/constants';
import { codesDir } from 'config/paths';
import { PY_LAUNCHER_SOURCE } from 'utils/pyLauncher';

// Python has no Docker image or Lambda in this deployment, so user code is
// executed with a local python3 subprocess (same flow as DockerTracer:
// write Main.py to a temp dir, run with ALGORITHM_VISUALIZER=1 and a time
// limit, then serve the visualization.json the library writes there).
// The tracer library lives in the repo-root tracers.py/ directory (the
// sibling of tracers.java/) and is put on PYTHONPATH for the subprocess.
// NOTE: a subprocess is not a sandbox. Do not expose this server publicly
// without putting the Python execution behind Docker first.
export class PyTracer extends Tracer {
  private readonly libraryDir: string;

  constructor() {
    super('py');
    // __dirname is server/src/tracers/py; the repo root is four levels up.
    this.libraryDir = path.resolve(__dirname, '..', '..', '..', '..', 'tracers.py', 'src');
  }

  build(release: Release) {
    // Nothing to build: the library is interpreted, not compiled or deployed.
    return Promise.resolve();
  }

  async update() {
    // The Python library is vendored in this repo (tracers.py/), so there is
    // no upstream release to track. Skipping the base class's GitHub fetch
    // also avoids a noisy 404 on every boot (algorithm-visualizer/tracers.py
    // does not exist upstream).
    return Promise.resolve();
  }

  route(router: express.Router) {
    router.post(`/${this.lang}`, (req, res, next) => {
      const {code} = req.body;
      const tempPath = path.resolve(codesDir, uuid.v4());
      // The user's code runs as Main.py under a small launcher that
      // pre-imports the tracer library (see utils/pyLauncher), so a
      // missing import can no longer break a run.
      fs.outputFile(path.resolve(tempPath, 'Main.py'), code)
        .then(() => fs.outputFile(path.resolve(tempPath, '_launcher.py'), PY_LAUNCHER_SOURCE))
        .then(() => new Promise<void>((resolve, reject) => {
          const python = process.env.PYTHON_BIN || 'python3';
          child_process.execFile(python, ['_launcher.py'], {
            cwd: tempPath,
            env: {
              ...process.env,
              ALGORITHM_VISUALIZER: '1',
              PYTHONPATH: this.libraryDir,
            },
            timeout: timeLimit,
            maxBuffer: 16 * 1024 * 1024,
          }, (error, stdout, stderr) => {
            if (!error) return resolve();
            if ((error as any).killed) return reject(new Error('Time Limit Exceeded'));
            reject((error as any).code ? new Error(stderr || error.message) : error);
          });
        }))
        .then(() => new Promise<void>((resolve, reject) => {
          // The library writes visualization.json via an atexit
          // flush, and because the launcher always imports it, the
          // file now exists even when nothing was visualized - so
          // an EMPTY command list gets the same actionable error a
          // missing file used to produce.
          const visualizationPath = path.resolve(tempPath, 'visualization.json');
          fs.readFile(visualizationPath, 'utf8', (readErr: any, raw: string) => {
            const noVisualization = () => reject(new Error('The code ran without errors but produced no visualization - nothing called the tracers. If the file only defines a class or functions, add a driver section at the end that creates the tracers, sets the layout root (Layout.set_root) and calls the code.'));
            if (readErr) return noVisualization();
            let commands: any;
            try {
              commands = JSON.parse(raw);
            } catch (parseErr) {
              return noVisualization();
            }
            if (!Array.isArray(commands) || commands.length === 0) return noVisualization();
            res.type('json').send(raw);
            return resolve();
          });
        }))
        .catch(next)
        .finally(() => fs.remove(tempPath));
    });
  }
}
