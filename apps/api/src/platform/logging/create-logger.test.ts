import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEST_CONFIG } from '../../test-support/test-config.js';
import { createLogger } from './create-logger.js';

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
