import { Writable } from 'node:stream';

import type { Logger } from 'pino';

import { createLogger } from '../platform/logging/create-logger.js';
import { TEST_CONFIG } from './test-config.js';

/** An in-memory log destination, so tests can search every byte the application logged. */
export class CapturedLogs {
  private readonly chunks: string[] = [];

  readonly stream = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      this.chunks.push(chunk.toString());
      done();
    },
  });

  /** A logger that writes here, built the way production builds it, for code under test that takes one. */
  readonly logger: Logger = createLogger({ config: TEST_CONFIG, destination: this.stream });

  /** Everything written so far, exactly as it would reach stdout. */
  text(): string {
    return this.chunks.join('');
  }

  records(): Record<string, unknown>[] {
    return this.text()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
