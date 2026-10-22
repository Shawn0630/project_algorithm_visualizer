import path from 'path';
import { Release, Tracer } from 'tracers/Tracer';
import express from 'express';
import uuid from 'uuid';
import fs from 'fs-extra';
import { memoryLimit, timeLimit } from 'config/constants';
import { codesDir } from 'config/paths';
import { errorSummary, execute } from 'utils/misc';
import { GitHubApi } from 'utils/apis';

export class DockerTracer extends Tracer {
  private readonly directory: string;
  private readonly imageName: string;

  constructor(lang: string) {
    super(lang);
    this.directory = path.resolve(__dirname, lang);
    this.imageName = `tracer-${this.lang}`;
  }

  build(release: Release) {
    const {tag_name} = release;
    return execute(`docker build -t ${this.imageName} . --build-arg tag_name=${tag_name}`, {
      cwd: this.directory,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }

  private dockerAvailable(): Promise<boolean> {
    return execute('docker info --format {{.ServerVersion}}')
      .then(() => true)
      .catch(() => false);
  }

  // Historical boot-time path - CppTracer overrides update()
  // to a no-op, so this no longer runs at boot (or on webhook
  // updates): the image builds lazily in ensureImage() on the
  // first C++ request instead. Kept for the record of why boots
  // used to be noisy.
  async update(release?: Release) {
    if (!await this.dockerAvailable()) {
      console.log('C++ tracer: Docker is not available - skipping the image build (start Docker Desktop to enable C++).');
      return;
    }
    try {
      await super.update(release);
    } catch (error) {
      console.log(`C++ tracer: image build failed - ${errorSummary(error)}`);
    }
  }

  private async ensureImage() {
    if (!await this.dockerAvailable()) {
      throw new Error('Docker is not running - C++ code runs in Docker, so start Docker Desktop and try again.');
    }
    const built = await execute(`docker image inspect ${this.imageName}`)
      .then(() => true)
      .catch(() => false);
    if (!built) {
      const {data} = await GitHubApi.getLatestRelease('algorithm-visualizer', `tracers.${this.lang}`);
      await this.build(data);
    }
  }

  route(router: express.Router) {
    router.post(`/${this.lang}`, (req, res, next) => {
      const {code} = req.body;
      const tempPath = path.resolve(codesDir, uuid.v4());
      this.ensureImage()
        .then(() => fs.outputFile(path.resolve(tempPath, `Main.${this.lang}`), code))
        .then(() => {
          const containerName = uuid.v4();
          let killed = false;
          const timer = setTimeout(() => {
            execute(`docker kill ${containerName}`).then(() => {
              killed = true;
            });
          }, timeLimit);
          return execute([
            'docker run --rm',
            `--name=${containerName}`,
            '-w=/usr/visualization',
            `-v=${tempPath}:/usr/visualization:rw`,
            `-m=${memoryLimit}m`,
            '-e ALGORITHM_VISUALIZER=1',
            this.imageName,
          ].join(' ')).catch(error => {
            if (killed) throw new Error('Time Limit Exceeded');
            throw error;
          }).finally(() => clearTimeout(timer));
        })
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
}
