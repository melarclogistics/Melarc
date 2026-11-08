import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import { randomKey, validEnv } from '../../test-support/config-env.js';
import { redactValue } from '../logging/redaction.js';
import { KEY_PURPOSES, keyEnvName } from './key-material.js';
import { inertConfig } from './inert-config.js';
import { loadConfig, type AppConfig } from './load-config.js';

/** A real configuration, with a caller secret as well as the key material, and the values it was made from. */
function loaded(): { config: AppConfig; secrets: string[] } {
  const callerSecret = randomKey();
  const env = validEnv({
    ATTESTATION_VERIFIER: 'service',
    ATTESTATION_VERIFIER_URL: 'http://127.0.0.1:9100',
    ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
    ATTESTATION_VERIFIER_CALLER_SECRET: callerSecret,
    KEY_TOTP_SEED_MATERIAL: `1:${randomKey()},2:${randomKey()}`,
    KEY_TOTP_SEED_ACTIVE_VERSION: '2',
  });
  const result = loadConfig(env);
  if (!result.ok) throw new Error('expected the environment to be accepted');
  const keys = KEY_PURPOSES.flatMap((purpose) =>
    (env[keyEnvName(purpose, 'MATERIAL')] ?? '')
      .split(',')
      .map((entry) => entry.slice(entry.indexOf(':') + 1)),
  );
  return { config: result.config, secrets: [callerSecret, ...keys] };
}

describe('every setting this task adds is redacted (S0.2)', () => {
  // Break caught: the whole configuration handed to a logger, as a startup banner or a crash report might, carrying the keys out.
  it('keeps key material and the caller secret out of a log line that carries the whole configuration', () => {
    const { config, secrets } = loaded();
    const logs = new CapturedLogs();

    logs.logger.info({ config }, 'the configuration, whole');
    logs.logger.info(config, 'the configuration, spread');
    logs.logger.error(
      { err: new Error(`failed with ${JSON.stringify(config)}`) },
      'a crash report',
    );

    expect(secrets).toHaveLength(KEY_PURPOSES.length + 2);
    for (const secret of secrets) expect(logs.text()).not.toContain(secret);
  });

  // Break caught: a secret recovered by a serialiser the logger is not in the path of.
  it('keeps them out of every other way a configuration is printed', () => {
    const { config, secrets } = loaded();
    const printed = [
      JSON.stringify(config),
      inspect(config, { depth: 12 }),
      JSON.stringify(redactValue({ config })),
      JSON.stringify(structuredClone(config)),
    ].join('\n');

    for (const secret of secrets) expect(printed).not.toContain(secret);
  });

  // Break caught: the key-name rule alone carrying the weight, so renaming a field would silently leak it. The wrapper holds
  // even when the logger's key rules are not consulted.
  it('keeps the key material out of the configuration structurally, not only by the name of its field', () => {
    const { config, secrets } = loaded();

    for (const secret of secrets) {
      expect(JSON.stringify(config)).not.toContain(secret);
      expect(inspect(config, { depth: 12 })).not.toContain(secret);
    }
  });

  // The describe configuration is what the generator and the contract check print and depend on.
  it('holds no value of any kind in the describe configuration: no secret, no key, no environment', () => {
    const rendered = JSON.stringify(inertConfig());

    expect(rendered).toContain('"custody":"describe"');
    expect(rendered).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(rendered).not.toContain('REDACTED');
    expect(rendered).not.toMatch(/postgres(ql)?:\/\//);
  });
});
