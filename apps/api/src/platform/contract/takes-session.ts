import { isJsonObject, type Json, type JsonObject } from './json.js';

/**
 * Whether an operation of the contract takes a session, and so is counted in the session's bucket of authenticated API requests
 * (`rate_limit_authenticated_api`, settings.md §7.7): it states no security (the default posture is a browser session or a rider's), or one of
 * its alternatives names a session scheme. The operations that state `security: []`, or only `vendorDevice` (the sign-in of the registered
 * browser), are reached before a session exists.
 *
 * This is the contract's own account, for the check of the contract and the tests that read it. The application's account is the access
 * declaration of each route (`needsSession`, `platform/routes/access-declaration.ts`), and `rate-limit-coverage.test.ts` holds the two to
 * each other for every operation the application serves, so that this reading cannot drift from the one the limiter acts on.
 */
export function takesSession(operation: JsonObject): boolean {
  const security = operation.security;
  if (!Array.isArray(security)) return true;
  return (security as readonly Json[]).some(
    (alternative) =>
      isJsonObject(alternative) &&
      ('browserSession' in alternative || 'riderSession' in alternative),
  );
}
