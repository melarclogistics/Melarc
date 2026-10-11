import { inertConfig } from '../platform/config/inert-config.js';
import type { AppConfig } from '../platform/config/load-config.js';

/**
 * The configuration for tools that describe the application to itself (the OpenAPI generator and the
 * contract check). It starts the application without listening and without a database, needs no environment,
 * holds no key material, and binds the inert describe adapters, which never connect, deliver or read a secret. It can
 * therefore run anywhere, including CI, and never needs a live dependency.
 */
export const DESCRIBE_CONFIG: AppConfig = inertConfig();
