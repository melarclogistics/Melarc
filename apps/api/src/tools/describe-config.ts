import type { AppConfig } from '../platform/config/load-config.js';

/**
 * The configuration for tools that describe the application to itself (the OpenAPI generator and the
 * contract check). It starts the application without listening and without a database, needs no environment,
 * and so can run anywhere, including CI, and never needs a live dependency.
 */
export const DESCRIBE_CONFIG: AppConfig = Object.freeze({
  nodeEnv: 'development',
  appEnv: 'local',
  http: Object.freeze({ host: '127.0.0.1', port: 1 }),
  logLevel: 'silent',
  shutdown: Object.freeze({ timeoutMs: 15_000, drainDelayMs: 0 }),
});
