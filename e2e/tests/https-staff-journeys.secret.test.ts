import { expect, test } from '../harness/https/secret-test.ts';
import { STAFF_JOURNEYS } from '../harness/journeys/staff-journeys.ts';

/**
 * @shows-secret
 * The staff journeys of the Ops Portal (S0.46) over the trusted HTTPS origin, in each engine: the evidence of AC-SLICE-000-127 (the
 * session cookies carry no lifetime of their own, and each engine stores them as the server set them) and of the Ops half of the
 * demonstration rows 1 to 6, 12, 13 (staff) and 14 and of the trusted browser (`AC-SLICE-000-133` to `-139`: the one persistent cookie,
 * stored by each engine as the server set it and sent to the staff sign-in routes alone), which `pnpm run test:e2e:https` runs in Chromium, Firefox and WebKit, in CI or on a
 * machine cleared for key material. It is the same list of journeys as the plain run (`staff-journeys.secret.test.ts`), so the two cannot
 * drift.
 *
 * **Blocked is not green.** Without test certificates a spec is skipped with the reason on a developer machine and fails in CI
 * (`harness/https-test.ts`); this one has not run on this workstation (no certificate authority may be made on it, the owner's ruling of
 * 11 October 2026), and its first run is the first time these journeys meet Firefox and WebKit. Passwords, setup keys, codes and the
 * one-time secrets of the custody bundles are typed into and read from real pages, so the recorders are off and the spec compares facts
 * and never a secret.
 */
test.describe.serial('the staff journeys, over the trusted HTTPS origin', () => {
  test.describe.configure({ timeout: 300_000 });

  for (const journey of STAFF_JOURNEYS) {
    test(journey.title, async ({ page, context, stack, sandbox, browserOrigin }) => {
      await journey.run({ page, context, stack, sandbox, origin: browserOrigin });

      expect(sandbox.externalBrowserRequests()).toEqual([]);
      expect(sandbox.outboundAttempts()).toEqual([]);
    });
  }
});
