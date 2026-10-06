import { Inject, Injectable, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { appWith, startTestApp, TEST_CONFIG, type TestApp } from '../test-support/test-app.js';
import type { AppConfig } from './config/load-config.js';
import { APP_CONFIG, LOGGER } from './platform.tokens.js';

/** A stand-in for any future module: it imports nothing and only asks for what the platform offers. */
@Injectable()
class PlatformConsumer {
  constructor(
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Inject(LOGGER) readonly logger: Logger,
  ) {}
}

@Module({ providers: [PlatformConsumer], exports: [PlatformConsumer] })
class ConsumerModule {}

let running: TestApp | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('PlatformModule', () => {
  // Break caught: a module being unable to read the validated configuration, which would send it back
  // to process.env and bypass validation, or the shared logger, which would send it to console.log and
  // bypass redaction.
  it('gives any module the validated configuration and the shared logger without importing anything', async () => {
    running = await startTestApp({ rootModule: appWith(ConsumerModule) });
    const consumer = running.app.get(PlatformConsumer);

    expect(consumer.config).toBe(TEST_CONFIG);
    expect(Object.isFrozen(consumer.config)).toBe(true);
    consumer.logger.info({ password: 'MODULE-SECRET' }, 'from a module');
    const record = running.logs.records().find((entry) => entry.msg === 'from a module');
    expect(record).toMatchObject({ password: '[REDACTED]' });
    expect(running.logs.text()).not.toContain('MODULE-SECRET');
  });
});
