import { Module } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../../app.module.js';
import { localKeys } from '../../../test-support/key-config.js';
import { startTestApp, TEST_CONFIG, type TestApp } from '../../../test-support/test-app.js';
import type { AppConfig } from '../../config/load-config.js';
import { APP_CONFIG } from '../../platform.tokens.js';
import {
  CLOCK,
  HASHER,
  SECRET_CIPHER,
  TOKEN_SERVICE,
  TOTP_VERIFIER,
  type Clock,
  type Hasher,
  type PortBindings,
  type SecretCipher,
  type TokenService,
  type TotpVerifier,
} from '../ports/index.js';
import { AesGcmSecretCipher } from './aes-gcm.secret-cipher.adapter.js';
import { Argon2Hasher } from './argon2.hasher.adapter.js';
import { hotp } from './hotp.js';
import { Rfc6238TotpVerifier } from './rfc6238.totp-verifier.adapter.js';
import { sealedContext } from './sealed-context.js';
import { Sha256TokenService } from './sha256.token-service.adapter.js';

// What the first consumer of these ports will write in the composition root, written here to show that it composes: each adapter is
// bound to its port's token, as an application singleton, with the configuration and the clock the container hands it. Nothing is
// bound in the runtime composition by this task (the composition test of S0.2 pins that none is until a real adapter is wanted).
const CHEAP = { memoryKiB: 64, passes: 1, parallelism: 1 } as const;
const FIXED: Clock = { now: () => new Date(165_000), monotonicMilliseconds: () => 0 };
const RUNTIME: AppConfig = { ...TEST_CONFIG, composition: 'runtime', keys: localKeys() };

const PORTS: PortBindings = {
  clock: { useValue: FIXED },
  hasher: {
    useFactory: (config: AppConfig) => new Argon2Hasher(config.keys, CHEAP),
    inject: [APP_CONFIG],
  },
  secretCipher: {
    useFactory: (config: AppConfig) => new AesGcmSecretCipher(config.keys),
    inject: [APP_CONFIG],
  },
  tokenService: { useClass: Sha256TokenService },
  totpVerifier: { useFactory: (clock: Clock) => new Rfc6238TotpVerifier(clock), inject: [CLOCK] },
};

@Module({})
class CompositionRootModule {}

let running: TestApp | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const boot = () =>
  startTestApp({
    config: RUNTIME,
    rootModule: (options) => ({
      module: CompositionRootModule,
      imports: [AppModule.register({ ...options, ports: PORTS })],
    }),
  });

const app = () => {
  if (running === undefined) throw new Error('no application is running');
  return running.app;
};
const hasher = () => app().get<Hasher>(HASHER, { strict: false });
const cipher = () => app().get<SecretCipher>(SECRET_CIPHER, { strict: false });
const tokens = () => app().get<TokenService>(TOKEN_SERVICE, { strict: false });
const totp = () => app().get<TotpVerifier>(TOTP_VERIFIER, { strict: false });

describe('the cryptographic adapters in the composition root (S0.3)', () => {
  // The application initialises, and `port-binding-check.ts` judges the container's own record of each bound port, before it
  // listens: reaching this assertion means each binding was accepted as an application singleton.
  it("binds each adapter to its port's token as an application singleton", async () => {
    running = await boot();

    expect(hasher()).toBeInstanceOf(Argon2Hasher);
    expect(cipher()).toBeInstanceOf(AesGcmSecretCipher);
    expect(tokens()).toBeInstanceOf(Sha256TokenService);
    expect(totp()).toBeInstanceOf(Rfc6238TotpVerifier);
    expect(hasher()).toBe(hasher());
    expect(cipher()).toBe(cipher());
    expect(tokens()).toBe(tokens());
    expect(totp()).toBe(totp());
  });

  it('does the work of its port when the container hands it back', async () => {
    running = await boot();

    const encoded = await hasher().hash('STAFF_PASSWORD', 'a synthetic passphrase');
    await expect(
      hasher().verify('STAFF_PASSWORD', 'a synthetic passphrase', encoded),
    ).resolves.toEqual({ matches: true, needsRehash: false });

    const context = sealedContext({
      principal: 'staff-1',
      operation: 'mfa.enrol',
      record: 'factor-1',
    });
    const seed = totp().newSeed();
    const sealed = await cipher().seal('TOTP_SEED', seed, context);
    const opened = await cipher().open('TOTP_SEED', sealed, context);
    expect(Buffer.from(opened).equals(seed)).toBe(true);

    // The verifier was given the clock bound under CLOCK: 165 seconds is step 5.
    expect(totp().verify(opened, hotp(opened, 5, 6), null)).toEqual({
      outcome: 'ACCEPTED',
      step: 5,
    });

    const issued = tokens().issue();
    expect(tokens().matches(issued.token, issued.hash)).toBe(true);
  });

  // A composition on a configuration without key custody cannot be started: the factories above throw while the container
  // builds them (the Hasher and the SecretCipher refuse to exist without key material, see their tests), and a failure there
  // stops the process. It is not booted here for that reason.
});
