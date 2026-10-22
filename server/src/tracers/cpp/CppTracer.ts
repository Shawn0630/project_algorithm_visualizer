import { DockerTracer } from 'tracers/DockerTracer';

export class CppTracer extends DockerTracer {
  constructor() {
    super('cpp');
  }

  // No boot-time work at all: the base-class update would fetch
  // the latest tracers.cpp release from GitHub and docker-build
  // the image on EVERY server start (with the platform warning
  // on Apple Silicon) - the noise that made boots look like they
  // were erroring. The image instead builds lazily on the first
  // C++ run via DockerTracer's ensureImage(), exactly like the
  // Python and Java tracers prepare on first use, and a missing
  // Docker daemon there produces one plain-language error.
  async update() {
    return Promise.resolve();
  }
}
