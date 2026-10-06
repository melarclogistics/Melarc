import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { CONFIG_KEYS, loadConfig } from './load-config.js';

const example = parseEnv(
  readFileSync(resolve(import.meta.dirname, '../../../.env.example'), 'utf8'),
);

describe('apps/api/.env.example', () => {
  // Break caught: an example that does not actually start the API, so the first thing a new developer
  // copies fails.
  it('is a configuration the API accepts', () => {
    expect(loadConfig(example).ok).toBe(true);
  });

  // Break caught: a configuration key added to the code and never documented.
  it('documents every key the configuration reads, and no other', () => {
    expect(Object.keys(example).toSorted()).toEqual([...CONFIG_KEYS].toSorted());
  });

  // Break caught: a real credential committed in the example, since .env.example is tracked by git.
  it('holds no secret-looking value', () => {
    for (const [name, value] of Object.entries(example)) {
      expect(`${name}=${value ?? ''}`).not.toMatch(/password|secret|token|key|credential/i);
    }
  });
});
