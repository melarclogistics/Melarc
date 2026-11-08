import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AccessFixtureModule } from './fixtures.js';
import { appWith, startTestApp } from './test-app.js';

/**
 * `startTestApp` builds the real application and opens its listener (correction F06). When it cannot finish starting, nothing it
 * had already built is left running: the application is closed before the failure is reported.
 */

let destroyed = 0;

@Injectable()
class Witness implements OnModuleDestroy {
  onModuleDestroy(): void {
    destroyed += 1;
  }
}

@Module({ providers: [Witness] })
class WitnessModule {}

describe('startTestApp: a start that fails part-way', () => {
  // Break caught: the application built, initialised and then refused (an undeclared route), left running with its providers and
  // pool open, one for every test that expects the refusal.
  it('closes the application it had built when it is refused for an undeclared route, and reports the refusal', async () => {
    destroyed = 0;

    const failure = await startTestApp({
      rootModule: appWith(AccessFixtureModule, WitnessModule),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/fixture-undeclared/);
    expect(destroyed).toBe(1);
  });

  // The ordinary start is not changed by it: it starts, answers, and stops once.
  it('starts and stops an application that is sound, closing it once', async () => {
    destroyed = 0;
    const running = await startTestApp({ rootModule: appWith(WitnessModule) });

    const response = await fetch(`${running.baseUrl}/livez`);
    expect(response.status).toBe(200);
    await running.stop();
    await running.stop();

    expect(destroyed).toBe(1);
  });
});
