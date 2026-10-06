import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { assertNoSecretsInClientEnv } from '../config/client-env';
import { DEFAULT_API_TARGET } from '../config/dev-proxy';

const example = parseEnv(readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8'));

describe('apps/ops-web/.env.example', () => {
  // Break caught: the documented proxy target drifting from the default the config really uses, so a
  // copied example behaves differently from no example at all.
  it('documents OPS_API_PROXY_TARGET with the default the dev config uses', () => {
    expect(example.OPS_API_PROXY_TARGET).toBe(DEFAULT_API_TARGET);
  });

  // Break caught: an undocumented setting, or a browser-exposed variable that looks like a secret,
  // committed in a tracked file.
  it('documents only that setting and exposes nothing to the browser bundle', () => {
    expect(Object.keys(example)).toEqual(['OPS_API_PROXY_TARGET']);
    expect(() => {
      assertNoSecretsInClientEnv(example);
    }).not.toThrow();
  });
});
