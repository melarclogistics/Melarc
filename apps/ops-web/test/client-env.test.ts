import { describe, expect, it } from 'vitest';

import { assertNoSecretsInClientEnv } from '../config/client-env';

describe('assertNoSecretsInClientEnv', () => {
  // Break caught: a guard so strict it blocks ordinary public settings, or an empty environment.
  it('accepts ordinary public settings and an empty environment', () => {
    expect(() => {
      assertNoSecretsInClientEnv({});
    }).not.toThrow();
    expect(() => {
      assertNoSecretsInClientEnv({ VITE_APP_ENV: 'local', VITE_FEATURE_FLAG: 'on' });
    }).not.toThrow();
  });

  // Break caught: a variable that looks like a credential being shipped to every browser, because
  // anything prefixed VITE_ is bundled into public JavaScript.
  it.each([
    'VITE_API_SECRET',
    'VITE_SESSION_TOKEN',
    'VITE_DB_PASSWORD',
    'VITE_PRIVATE_KEY',
    'VITE_SIGNING_KEY',
    'VITE_PROVIDER_CREDENTIALS',
    'VITE_hubtel_secret',
  ])('refuses %s', (name) => {
    expect(() => {
      assertNoSecretsInClientEnv({ [name]: 'value' });
    }).toThrow(name);
  });

  // Break caught: the refusal printing the value, which would leak the secret into build logs.
  it('names the variable but never prints its value', () => {
    let message = '';
    try {
      assertNoSecretsInClientEnv({ VITE_API_SECRET: 'hunter2-value-must-not-appear' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('VITE_API_SECRET');
    expect(message).not.toContain('hunter2-value-must-not-appear');
  });

  // Break caught: only the first offender reported, so fixing them takes one build per variable.
  it('reports every offending variable', () => {
    expect(() => {
      assertNoSecretsInClientEnv({ VITE_A_SECRET: 'x', VITE_B_TOKEN: 'y', VITE_OK: 'z' });
    }).toThrow(/VITE_A_SECRET.*VITE_B_TOKEN/);
  });

  // Break caught: a false positive on server-side variables. Without the VITE_ prefix they never reach
  // the bundle, and refusing them would block every developer who has a database password set.
  it('ignores variables that cannot reach the bundle', () => {
    expect(() => {
      assertNoSecretsInClientEnv({
        DATABASE_PASSWORD: 'x',
        SESSION_SECRET: 'y',
        AWS_SECRET_ACCESS_KEY: 'z',
      });
    }).not.toThrow();
  });
});
