import path from 'path';
import child_process from 'child_process';
import { Release, Tracer } from 'tracers/Tracer';
import express from 'express';
import uuid from 'uuid';
import fs from 'fs-extra';
import { timeLimit } from 'config/constants';
import { codesDir } from 'config/paths';

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
      fs.outputFile(path.resolve(tempPath, 'Main.py'), code)
        .then(() => new Promise<void>((resolve, reject) => {
          const python = process.env.PYTHON_BIN || 'python3';
          child_process.execFile(python, ['Main.py'], {
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
        .then(() => new Promise((resolve, reject) => {
          const visualizationPath = path.resolve(tempPath, 'visualization.json');
          res.sendFile(visualizationPath, (err: any) => {
            if (err) return reject(new Error('Visualization Not Found'));
            resolve();
          });
        }))
        .catch(next)
        .finally(() => fs.remove(tempPath));
    });
  }
}
