import path from 'path';
import child_process from 'child_process';
import fs from 'fs-extra';
import { codesDir } from 'config/paths';

// Shared plumbing for running Java visualizations locally:
// compiling the vendored tracers.java library once (cached under
// codesDir) and building classpaths that include it plus its only
// dependency, the vendored Gson jar. Used by JavaTracer (live
// runs) and by the AI assistant's dry runs, so both go through
// exactly the same library build.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
export const JAVA_LIBRARY_SOURCE_DIR = path.resolve(repoRoot, 'tracers.java', 'src', 'main', 'java', 'org', 'algorithm_visualizer');
export const JAVA_LIBRARY_CLASSES_DIR = path.resolve(codesDir, '.tracers-java-classes');
export const JAVA_GSON_JAR = path.resolve(__dirname, '..', 'tracers', 'java', 'lib', 'gson-2.8.5.jar');

export function javaClasspath(...entries: string[]): string {
  return [...entries, JAVA_LIBRARY_CLASSES_DIR, JAVA_GSON_JAR].join(path.delimiter);
}

export function execFileChecked(file: string, args: string[], options: child_process.ExecFileOptions, notFoundMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child_process.execFile(file, args, options, (error, stdout, stderr) => {
      if (!error) return resolve();
      if ((error as any).killed) return reject(new Error('Time Limit Exceeded'));
      if ((error as any).code === 'ENOENT') return reject(new Error(notFoundMessage));
      reject((error as any).code ? new Error((stderr || '').toString().trim() || error.message) : error);
    });
  });
}

let libraryBuild: Promise<void> | null = null;

// Compiles the tracers.java library once per server run; a failed
// build is forgotten so the next caller retries and reports the
// error again.
export function ensureJavaLibrary(): Promise<void> {
  if (!libraryBuild) {
    libraryBuild = (async () => {
      await fs.remove(JAVA_LIBRARY_CLASSES_DIR);
      await fs.ensureDir(JAVA_LIBRARY_CLASSES_DIR);
      const sources = (await fs.readdir(JAVA_LIBRARY_SOURCE_DIR))
        .filter(file => file.endsWith('.java'))
        .map(file => path.resolve(JAVA_LIBRARY_SOURCE_DIR, file));
      await execFileChecked(
        process.env.JAVAC_BIN || 'javac',
        ['-cp', JAVA_GSON_JAR, '-d', JAVA_LIBRARY_CLASSES_DIR, ...sources],
        { timeout: 60000 },
        'Java compiler (javac) not found. Install a JDK and make sure javac is on the PATH, or set JAVAC_BIN.',
      );
    })().catch(error => {
      libraryBuild = null;
      throw error;
    });
  }
  return libraryBuild;
}
