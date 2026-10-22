import path from 'path';
import child_process from 'child_process';
import express from 'express';
import uuid from 'uuid';
import fs from 'fs-extra';
import { Release, Tracer } from 'tracers/Tracer';
import { timeLimit } from 'config/constants';
import { codesDir } from 'config/paths';
import { ensureJavaLibrary, execFileChecked, javaClasspath } from 'utils/javaLibrary';

// Java runs locally, like Python: user code is compiled with javac
// against the vendored tracers.java library (repo-root tracers.java/,
// the sibling of tracers.py/) and executed with a local java subprocess
// (write Main.java, compile, run with ALGORITHM_VISUALIZER=1, serve the
// visualization.json the library writes). The library's only dependency,
// Gson, is vendored at lib/gson-2.8.5.jar. There is no remote execution
// path: nothing here talks to AWS.
// NOTE: a subprocess is not a sandbox. Do not expose this server publicly
// without putting the Java execution behind Docker first.
export class JavaTracer extends Tracer {
  constructor() {
    super('java');
  }

  build(release: Release) {
    // Nothing to build ahead of time: the library is compiled lazily on
    // the first request (see utils/javaLibrary) and cached under codesDir.
    return Promise.resolve();
  }

  async update() {
    // The Java library is vendored in this repo (tracers.java/), so there is
    // no upstream release to track; skipping the base class's GitHub fetch
    // also keeps boot free of network calls for this tracer.
    return Promise.resolve();
  }

  route(router: express.Router) {
    router.post(`/${this.lang}`, (req, res, next) => {
      const {code} = req.body;
      // The file runs as Main.java / class Main: with no Main class
      // there is nothing to execute, and the JVM's error for that is
      // cryptic - say it plainly instead.
      if (!/\bclass\s+Main\b/.test(code || '')) {
        return next(new Error('This Java file defines no Main class, so there is nothing to run: Java visualizations run as Main.java (class Main) with a public static void main that creates the tracers, sets the layout root once and calls the code. A file that only defines class Solution has no entry point - exercise it from the Testcase panel, or add a Main driver.'));
      }
      const tempPath = path.resolve(codesDir, uuid.v4());
      fs.outputFile(path.resolve(tempPath, 'Main.java'), code)
        .then(() => ensureJavaLibrary())
        .then(() => execFileChecked(
          process.env.JAVAC_BIN || 'javac',
          ['-cp', javaClasspath(), '-d', tempPath, path.resolve(tempPath, 'Main.java')],
          {timeout: 30000},
          'Java compiler (javac) not found. Install a JDK and make sure javac is on the PATH, or set JAVAC_BIN.',
        ))
        .then(() => execFileChecked(
          process.env.JAVA_BIN || 'java',
          ['-cp', javaClasspath(tempPath), 'Main'],
          {cwd: tempPath, env: {...process.env, ALGORITHM_VISUALIZER: '1'}, timeout: timeLimit, maxBuffer: 16 * 1024 * 1024},
          'Java runtime (java) not found. Install a JDK/JRE and make sure java is on the PATH, or set JAVA_BIN.',
        ))
        .then(() => new Promise((resolve, reject) => {
          const visualizationPath = path.resolve(tempPath, 'visualization.json');
          res.sendFile(visualizationPath, (err: any) => {
            if (err) return reject(new Error('The code ran without errors but produced no visualization - nothing called the tracers. Make sure the code creates tracers, sets the layout root once (Layout.setRoot) and calls delay() as it runs.'));
            resolve();
          });
        }))
        .catch(next)
        .finally(() => fs.remove(tempPath));
    });
  }
}
