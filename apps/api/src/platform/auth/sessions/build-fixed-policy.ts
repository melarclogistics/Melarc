import type { CompiledFixedPolicy } from './session-authority.js';

/**
 * The fixed-policy revision this build is compiled for, for each audience that has one (SECURITY_DESIGN.md section 13.10; the
 * session-issue protocol refuses an instance below the stored floor). S0.48 declared the Vendor's at revision 1, the fixed Vendor bundle
 * the seed writes (`tools/seed/bundles.ts`); S0.59 declared the Rider's at revision 1 of the fixed Rider bundle, with the sign-in that
 * issues its sessions (what two builds of different revisions do is proved by S0.63). **Revision 2 (S1.8, SLICE-001): the Vendor's six
 * keys and the Rider's seven for the pickup operations**, an addition, so the floor stays 1.
 *
 * **One number, read by three things that must agree.** The build (`app.module.ts` composes it), the seed (`tools/seed/bundles.ts`
 * writes it as the revision of a *new* database, so that a database seeded today holds the latest released revision, which is what
 * `revision` means) and the migration that records a release on a database seeded earlier (`0043`, which calls
 * `melarc.change_fixed_policy`, whose floor is the stored revision plus one: a stored revision that trailed the build would make the
 * next reduction raise the floor too low and end no session). `slice-001-grants.db.test.ts` holds the seed and the build to each other
 * and `two-builds.db.test.ts` proves the reduction on a database seeded fresh.
 *
 * A release that adds to what a Vendor or a Rider may do, or compiles a new predicate for them, raises the revision here and records the
 * release in a migration (an addition); one that removes or narrows raises the floor too, in the same migration. A composition that gives
 * its own (a test) replaces this.
 */
export const BUILD_FIXED_POLICY: CompiledFixedPolicy = Object.freeze({ VENDOR: 2, RIDER: 2 });
