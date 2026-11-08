import { STAFF_JOURNEYS } from '../harness/journeys/staff-journeys.ts';
import { expect, test } from '../harness/secret-test.ts';

/**
 * @shows-secret
 * The staff journeys of the Ops Portal (S0.46), over plain HTTP in Chromium: `pnpm run test:e2e`. Passwords, setup keys, codes and the
 * one-time secrets of the custody bundles are typed into and read from real pages, so the spec runs with the recorders off and compares
 * facts and never a secret (`harness/evidence-policy.ts`).
 *
 * **This run is a diagnostic and not the evidence of AC-SLICE-000-127.** The session cookies are `Secure`, and what an engine does with a
 * `Secure` cookie on a loopback address over plain HTTP is its own business; the evidence is the same journeys over the trusted HTTPS
 * origin in Chromium, Firefox and WebKit (`https-staff-journeys.secret.test.ts`, `pnpm run test:e2e:https`, CI). The journeys are one
 * story told in order, so they run serially and a failure stops the rest.
 */
test.describe.serial('the staff journeys, over plain HTTP in Chromium', () => {
  test.describe.configure({ timeout: 300_000 });

  for (const journey of STAFF_JOURNEYS) {
    test(journey.title, async ({ page, context, stack, sandbox, browserOrigin }) => {
      await journey.run({ page, context, stack, sandbox, origin: browserOrigin });

      // Nothing left the machine, from the browser or from the API or the worker.
      expect(sandbox.externalBrowserRequests()).toEqual([]);
      expect(sandbox.outboundAttempts()).toEqual([]);
    });
  }
});
