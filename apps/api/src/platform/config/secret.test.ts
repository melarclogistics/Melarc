import { format, inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { Secret } from './secret.js';

const VALUE = 'SENTINEL-KEY-MATERIAL-0123456789';

describe('Secret', () => {
  // Break caught: a secret that reads back as itself, so any code that logs or serialises a configuration carries it out.
  it('reveals its value only when asked', () => {
    expect(new Secret(VALUE).reveal()).toBe(VALUE);
  });

  it.each([
    ['JSON.stringify', (secret: Secret) => JSON.stringify({ secret })],
    ['JSON.stringify of the secret itself', (secret: Secret) => JSON.stringify(secret)],
    ['String()', (secret: Secret) => String(secret)],
    ['concatenation', (secret: Secret) => 'value: ' + String(secret)],
    ['util.inspect', (secret: Secret) => inspect(secret, { depth: 5 })],
    [
      'util.inspect of a holder',
      (secret: Secret) => inspect({ keys: { totp: { secret } } }, { depth: 9 }),
    ],
    ['util.format %s', (secret: Secret) => format('%s', secret)],
    ['util.format %o', (secret: Secret) => format('%o', secret)],
    ['util.format %j', (secret: Secret) => format('%j', secret)],
    ['Object.entries', (secret: Secret) => JSON.stringify(Object.entries(secret))],
    [
      'a spread',
      // eslint-disable-next-line @typescript-eslint/no-misused-spread -- a spread of a secret carrying nothing is the behaviour under test
      (secret: Secret) => JSON.stringify({ ...secret }),
    ],
    ['structuredClone', (secret: Secret) => JSON.stringify(structuredClone(secret))],
  ])('does not print its value through %s', (_label, render) => {
    expect(render(new Secret(VALUE))).not.toContain(VALUE);
  });

  it('says plainly that it is redacted when printed', () => {
    const secret = new Secret(VALUE);

    expect(String(secret)).toBe('[REDACTED]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect(secret)).toBe('Secret([REDACTED])');
  });

  // Break caught: the value kept in a property a reflection or a debugger dump can list.
  it('keeps the value out of every own property', () => {
    const secret = new Secret(VALUE);

    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(Object.getOwnPropertySymbols(secret)).toEqual([]);
  });
});
