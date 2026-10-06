import type { AppConfig } from '../platform/config/load-config.js';

export const TEST_CONFIG: AppConfig = Object.freeze({
  nodeEnv: 'test',
  appEnv: 'local',
  http: Object.freeze({ host: '127.0.0.1', port: 0 }),
  logLevel: 'info',
  shutdown: Object.freeze({ timeoutMs: 5000, drainDelayMs: 0 }),
});
