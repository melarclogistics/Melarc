/** Injection tokens for platform values that are not classes. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const LOGGER = Symbol('LOGGER');
export const DATABASE_POOL = Symbol('DATABASE_POOL');
/** What the database service needs besides its pool: the clock, the deadlines, the pool size and the statement canceller. */
export const DATABASE_RUNTIME = Symbol('DATABASE_RUNTIME');
