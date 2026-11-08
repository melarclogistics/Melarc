import { INERT_HTTP, inertConfig } from '../platform/config/inert-config.js';
import type { AppConfig } from '../platform/config/load-config.js';

/**
 * The configuration of the default test application: the inert one, so every port resolves to a describe adapter and nothing
 * connects or reads a secret, on an ephemeral port and with a short shutdown budget.
 */
export const TEST_CONFIG: AppConfig = inertConfig({
  nodeEnv: 'test',
  http: Object.freeze({ ...INERT_HTTP, port: 0 }),
  logLevel: 'info',
  shutdown: Object.freeze({ timeoutMs: 5000, drainDelayMs: 0 }),
});
