import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import { installFaultHandlers } from './fault-handlers.js';

/** Stands in for the process: the only parts the handlers touch are its events and exit. */
function fakeProcess(logs: CapturedLogs) {
  const emitter = new EventEmitter();
  const exits: { code: number; recordsLoggedBefore: number }[] = [];
  return {
    emitter,
    exits,
    runtime: {
      on: (event: string, listener: (value: unknown) => void) => emitter.on(event, listener),
      exit: (code: number) => {
        exits.push({ code, recordsLoggedBefore: logs.records().length });
      },
    },
  };
}

describe('installFaultHandlers', () => {
  // Break caught: Node's default crash output (the error with every attached property, unredacted)
  // reaching stderr, and the process exiting before the fatal line is written.
  it('logs an uncaught exception through the redactor, then exits with 1', () => {
    const logs = new CapturedLogs();
    const { emitter, exits, runtime } = fakeProcess(logs);
    installFaultHandlers(logs.logger, runtime);

    const error = new Error('connect failed postgres://melarc:hunter2@db.internal/melarc');
    Object.assign(error, { request: { body: { password: 'BODY-SECRET' } } });
    emitter.emit('uncaughtException', error);

    expect(logs.records()).toHaveLength(1);
    expect(logs.records()[0]).toMatchObject({
      level: 'fatal',
      msg: 'uncaught exception',
      err: { type: 'Error' },
    });
    expect(logs.text()).not.toContain('hunter2');
    expect(logs.text()).not.toContain('BODY-SECRET');
    expect(exits).toEqual([{ code: 1, recordsLoggedBefore: 1 }]);
  });

  // Break caught: an unhandled rejection with a non-Error reason being stringified wholesale.
  it('logs an unhandled rejection through the redactor, then exits with 1', () => {
    const logs = new CapturedLogs();
    const { emitter, exits, runtime } = fakeProcess(logs);
    installFaultHandlers(logs.logger, runtime);

    emitter.emit('unhandledRejection', 'refused: password=hunter2');

    expect(logs.records()[0]).toMatchObject({ level: 'fatal', msg: 'unhandled rejection' });
    expect(logs.text()).not.toContain('hunter2');
    expect(exits).toEqual([{ code: 1, recordsLoggedBefore: 1 }]);
  });
});
