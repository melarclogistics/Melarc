import { MAX_BUCKET_LIMIT } from '../../../src/platform/limiter/limiter-parameters.js';

/**
 * The sub-ceiling of the operations that cause an outbound text (`provider_initiating_operation_ceiling_per_minute`, settings.md section
 * 7.7; R76), for a test file whose subject is something else.
 *
 * The seed holds it at 20 a minute for each session, and the application enforces it on the five operations that declare it
 * (`confirmPickupRequest`, `dispatchManifest`, `skipPickupStop`, `initiateHandshake`, `requestSmsHandshakeFallback`). A file that tests one of
 * them signs in once and then makes dozens of requests from that one session inside a minute, refusals included (a request counts when it is
 * admitted, whatever the operation then answers), so against the seeded value the twenty-first would answer `429` and the file would be
 * testing the limiter, by accident. Such a file lifts the value for its own database, here, and says so; **the ceiling is proven by files
 * of its own** (`alone/rate-limiter.db.test.ts` for the counter, `authentication-guard.db.test.ts` for the guard and
 * `provider-ceiling-routes.db.test.ts` for the five routes), which do not call this, or set a low value on purpose.
 *
 * The value is the greatest the limiter accepts (`MAX_BUCKET_LIMIT`): a larger one is not a limit, and the limiter answers that it cannot decide.
 *
 * It touches the one row of the one disposable database the file made. It is a statement of the administrator's connection, as every
 * arrangement of the kit is (`Admin`): the application never changes a setting this way.
 */
export const LIFTED_PROVIDER_CEILING = MAX_BUCKET_LIMIT;

export async function liftProviderCeiling(admin: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  await admin.query(
    `update setting set value = $1::jsonb where key = 'provider_initiating_operation_ceiling_per_minute'`,
    [JSON.stringify(LIFTED_PROVIDER_CEILING)],
  );
}
