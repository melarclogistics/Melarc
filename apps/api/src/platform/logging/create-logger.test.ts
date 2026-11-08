import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_CONFIG } from '../../test-support/test-config.js';
import { createLogger, createServiceLogger } from './create-logger.js';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the process logger', () => {
  // Break caught: a fatal line that is still in a buffer when the process exits. pino's default destination writes
  // asynchronously, and the fault handlers log the crash and then call process.exit(1) at once, so under any
  // backpressure on stdout (a slow log collector, a full pipe) the line that says why the process died was lost.
  // With no destination given the logger writes to stdout synchronously: the line has left when the call returns.
  it('writes to stdout synchronously by default, so a line logged just before an exit is not lost', () => {
    const written: { fd: number; text: string }[] = [];
    vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, data: string | Uint8Array) => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString();
      written.push({ fd, text });
      return Buffer.byteLength(text);
    });

    createLogger({ config: TEST_CONFIG }).fatal({ reason: 'uncaught' }, 'uncaught exception');

    expect(written).toHaveLength(1);
    expect(written[0]?.fd).toBe(1);
    expect(JSON.parse(written[0]?.text ?? '')).toMatchObject({
      level: 'fatal',
      msg: 'uncaught exception',
      reason: 'uncaught',
    });
  });

  // Break caught (S0.18): the delivery worker's lines carrying the API's service name, which would make the two processes
  // indistinguishable in a log collector, or reaching the log without the central redaction.
  it('names the service it logs for, and redacts every line as the API logger does', () => {
    const lines: string[] = [];
    const logger = createServiceLogger({
      service: 'melarc-delivery-worker',
      level: 'info',
      appEnv: 'staging',
      destination: { write: (line: string) => void lines.push(line) },
    });

    logger.info({ job_id: 'j-1', token: 'SENTINEL-LOGGED-TOKEN' }, 'delivery outcome recorded');
    logger.debug('below the level');

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(record).toMatchObject({
      service: 'melarc-delivery-worker',
      env: 'staging',
      level: 'info',
      msg: 'delivery outcome recorded',
      job_id: 'j-1',
    });
    expect(lines[0]).not.toContain('SENTINEL-LOGGED-TOKEN');
    expect(record).not.toHaveProperty('request_id');
  });

  it('keeps the API name for the API logger', () => {
    const lines: string[] = [];

    createLogger({
      config: TEST_CONFIG,
      destination: { write: (line: string) => void lines.push(line) },
    }).info('x');

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ service: 'melarc-api' });
  });

  // Break caught: the default taking over a destination that a caller chose, as a test does to read every byte.
  it('writes to the destination it is given, and not to stdout', () => {
    const spy = vi.spyOn(fs, 'writeSync');
    const lines: string[] = [];

    createLogger({
      config: TEST_CONFIG,
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    }).info('to the destination');

    expect(lines).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
