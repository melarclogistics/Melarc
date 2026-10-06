import { describe, expect, it } from 'vitest';

import { assertNoSecretsInClientEnv, LOOKS_LIKE_A_SECRET } from '../config/client-env';

/** Every word the guard recognises as a secret's name. A word is added here and in the guard together, on purpose. */
const SECRET_WORDS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'KEY',
  'CREDENTIAL',
  'PRIVATE',
  'SIGNATURE',
] as const;

describe('the words that make a variable name look like a secret', () => {
  // Break caught: a word leaving the guard (or arriving in it) with no test that notices. The list in the guard
  // is read back from the pattern itself, and compared with the list above.
  it('are exactly the words this test tries one by one', () => {
    const alternatives = /^\((.+)\)$/.exec(LOOKS_LIKE_A_SECRET.source)?.[1]?.split('|');

    expect(alternatives).toEqual([...SECRET_WORDS]);
    expect(LOOKS_LIKE_A_SECRET.flags).toBe('i');
  });

  // Break caught: a word dropped from the guard. Each name below holds the word it is named for and none of
  // the others (the first check), so a name that merely contains another word, as VITE_PRIVATE_KEY holds KEY,
  // cannot keep the dropped word's test passing.
  it.each(SECRET_WORDS)('refuses a name that holds the word %s and no other word', (word) => {
    const name = `VITE_THE_${word}`;

    expect(SECRET_WORDS.filter((other) => name.includes(other))).toEqual([word]);
    expect(() => {
      assertNoSecretsInClientEnv({ [name]: 'value' });
    }).toThrow(name);
  });

  // Break caught: the pattern losing its case-insensitivity, after which lower-case names get through.
  it.each(SECRET_WORDS)('recognises the word %s in lower case, too', (word) => {
    const name = `VITE_the_${word.toLowerCase()}`;

    expect(() => {
      assertNoSecretsInClientEnv({ [name]: 'value' });
    }).toThrow(name);
  });
});

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
