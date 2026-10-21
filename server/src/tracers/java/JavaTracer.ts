import path from 'path';
import child_process from 'child_process';
import express from 'express';
import uuid from 'uuid';
import fs from 'fs-extra';
import { Release, Tracer } from 'tracers/Tracer';
import { timeLimit } from 'config/constants';
import { codesDir } from 'config/paths';

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
  private readonly librarySourceDir: string;
  private readonly libraryClassesDir: string;
  private readonly gsonJar: string;
  private libraryBuild: Promise<void> | null = null;

  constructor() {
    super('java');
    // __dirname is server/src/tracers/java; the repo root is four levels up.
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    this.librarySourceDir = path.resolve(repoRoot, 'tracers.java', 'src', 'main', 'java', 'org', 'algorithm_visualizer');
    this.libraryClassesDir = path.resolve(codesDir, '.tracers-java-classes');
    this.gsonJar = path.resolve(__dirname, 'lib', 'gson-2.8.5.jar');
  }

  build(release: Release) {
    // Nothing to build ahead of time: the library is compiled lazily on
    // the first request (see ensureLibrary) and cached under codesDir.
    return Promise.resolve();
  }

  async update() {
    // The Java library is vendored in this repo (tracers.java/), so there
    // is no upstream release to track; skipping the base class's GitHub
    // fetch also keeps boot free of network calls for this tracer.
    return Promise.resolve();
  }

  route(router: express.Router) {
    router.post(`/${this.lang}`, (req, res, next) => {
      const {code} = req.body;
      const tempPath = path.resolve(codesDir, uuid.v4());
      fs.outputFile(path.resolve(tempPath, 'Main.java'), code)
        .then(() => this.ensureLibrary())
        .then(() => this.execFileChecked(
          process.env.JAVAC_BIN || 'javac',
          ['-cp', this.classpath(), '-d', tempPath, path.resolve(tempPath, 'Main.java')],
          {timeout: 30000},
          'Java compiler (javac) not found. Install a JDK and make sure javac is on the PATH, or set JAVAC_BIN.',
        ))
        .then(() => this.execFileChecked(
          process.env.JAVA_BIN || 'java',
          ['-cp', this.classpath(tempPath), 'Main'],
          {cwd: tempPath, env: {...process.env, ALGORITHM_VISUALIZER: '1'}, timeout: timeLimit, maxBuffer: 16 * 1024 * 1024},
          'Java runtime (java) not found. Install a JDK/JRE and make sure java is on the PATH, or set JAVA_BIN.',
        ))
        .then(() => new Promise((resolve, reject) => {
          const visualizationPath = path.resolve(tempPath, 'visualization.json');
          res.sendFile(visualizationPath, (err: any) => {
            if (err) return reject(new Error('The code ran without errors but produced no visualization - nothing called the tracers. Make sure the code creates tracers, sets the layout root once (Layout.setRoot / Layout::setRoot) and calls delay() as it runs.'));
            resolve();
          });
        }))
        .catch(next)
        .finally(() => fs.remove(tempPath));
    });
  }

  private classpath(...entries: string[]) {
    return [...entries, this.libraryClassesDir, this.gsonJar].join(path.delimiter);
  }

  // Compiles the tracers.java library once per server run (its classes are
  // cached under codesDir); a failed build is forgotten so the next
  // request retries and reports the error again.
  private ensureLibrary(): Promise<void> {
    if (!this.libraryBuild) {
      this.libraryBuild = (async () => {
        await fs.remove(this.libraryClassesDir);
        await fs.ensureDir(this.libraryClassesDir);
        const sources = (await fs.readdir(this.librarySourceDir))
          .filter(file => file.endsWith('.java'))
          .map(file => path.resolve(this.librarySourceDir, file));
        await this.execFileChecked(
          process.env.JAVAC_BIN || 'javac',
          ['-cp', this.gsonJar, '-d', this.libraryClassesDir, ...sources],
          {timeout: 60000},
          'Java compiler (javac) not found. Install a JDK and make sure javac is on the PATH, or set JAVAC_BIN.',
        );
      })().catch(error => {
        this.libraryBuild = null;
        throw error;
      });
    }
    return this.libraryBuild;
  }

  private execFileChecked(file: string, args: string[], options: child_process.ExecFileOptions, notFoundMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      child_process.execFile(file, args, options, (error, stdout, stderr) => {
        if (!error) return resolve();
        if ((error as any).killed) return reject(new Error('Time Limit Exceeded'));
        if ((error as any).code === 'ENOENT') return reject(new Error(notFoundMessage));
        reject((error as any).code ? new Error(stderr || error.message) : error);
      });
    });
  }
}
