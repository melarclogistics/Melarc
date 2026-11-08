import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { waitUntilBlocked } from './support/policy-fixtures.js';
import { REQUEST, startRecoveryRoutes, type RecoveryRoutes } from './support/recovery-routes.js';
import { codeOf, OPS } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import { VENDOR } from './support/vendor-routes.js';
import { accountIdentifier, SOME_SECRET_HASH } from './support/vendors.js';

/**
 * S0.50, `requestCredentialRecovery`, against the real application and a real PostgreSQL (`AC-SLICE-000-20`, `-21`, `-104`, `-107`, the
 * request half of `-121` and of `GBT-B15`). Every request goes through HTTP from the surface's origin with no session; what the application
 * did is read from a second connection, and the excluded requests from the application's own metrics registry. No delivery worker runs, so
 * an answer that waited for a provider could not have come back.
 */
let routes: RecoveryRoutes;

beforeAll(async () => {
  routes = await startRecoveryRoutes();
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

/** What two answers must share to be indistinguishable: everything but the request's own identifier. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  text: response.text,
  contentType: response.header('content-type'),
  cacheControl: response.header('cache-control'),
  cookies: response.setCookies,
});

const eventsFor = (principalId: string) =>
  rows<{
    object_id: string;
    resulting_state: string;
    actor_type: string;
    enhanced: boolean;
    detail: unknown;
  }>(
    `select object_id, resulting_state, actor_type, enhanced, detail from audit_event
      where event_code = 'auth.recovery.requested' and related_ids ->> 'principal_id' = $1 order by recorded_at, id`,
    [principalId],
  );

/** Moves a request's issue back in time (and its expiry with it), as if it had been issued that long ago: the arrangement sets the guard aside. */
async function age(id: string, seconds: number): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update recovery_request set issued_at = issued_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2)
        where id = $1`,
      [id, seconds],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

/** Ends a request's message as the worker would (FAILED) or as an ending act would (CANCELLED), the payload erased. */
async function endMessage(requestId: string, state: 'FAILED' | 'CANCELLED'): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update credential_delivery_job
          set state = $2, outcome_class = $3, payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
              payload_envelope_version = null, payload_erased_at = clock_timestamp()
        where redemption_record_type = 'RECOVERY_REQUEST' and redemption_record_id = $1`,
      [requestId, state, state === 'FAILED' ? 'REJECTED' : 'CANCELLED'],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

describe('the link goes to the registered channel and nowhere else (AC-SLICE-000-20)', () => {
  // Break caught: a link sent to an address the request named, to the wrong surface, or a staff message carrying a vendor's identifier.
  it('queues a staff member’s link to the verified work email, for the Ops Portal', async () => {
    const { row } = await routes.staffMember();

    const answer = await routes.requestRecovery('STAFF', `  ${row.workEmail.toUpperCase()} `);

    expect([answer.status, answer.text]).toEqual([202, '']);
    const [request] = await routes.requestsOf(row.id);
    expect(request).toMatchObject({
      state: 'PENDING',
      channel: 'EMAIL',
      initiated_by: null,
      job: 'QUEUED',
    });
    const message = await routes.deliveredFor(routes.admin, request?.id ?? '');
    expect(message?.destination).toBe(row.workEmail);
    expect(message?.link.startsWith(`${OPS}/recovery/complete#token=`)).toBe(true);
    expect(message?.accountIdentifier).toBeUndefined();
    expect(
      await rows(`select kind from credential_delivery_job where redemption_record_id = $1`, [
        request?.id,
      ]),
    ).toEqual([{ kind: 'RECOVERY_LINK' }]);
  });

  it('queues a vendor’s link to the address of its delivery channel, with the account identifier, for the Vendor PWA', async () => {
    const byEmail = await routes.vendor({ secretHash: SOME_SECRET_HASH });
    const byPhone = await routes.vendor({
      secretHash: SOME_SECRET_HASH,
      recoveryPhone: '+233201234567',
      deliveryChannel: 'PHONE',
    });

    for (const [arranged, channel, destination] of [
      [byEmail, 'EMAIL', byEmail.row.recoveryEmail],
      [byPhone, 'SMS', '+233201234567'],
    ] as const) {
      const answer = await routes.requestRecovery(
        'VENDOR',
        arranged.row.accountIdentifier.toLowerCase(),
      );
      expect(answer.status).toBe(202);
      const [request] = await routes.requestsOf(arranged.row.accountId);
      expect(request).toMatchObject({ state: 'PENDING', channel });
      const message = await routes.deliveredFor(routes.admin, request?.id ?? '');
      expect(message?.destination).toBe(destination);
      expect(message?.accountIdentifier).toBe(arranged.row.accountIdentifier);
      expect(message?.link.startsWith(`${VENDOR}/recovery/complete#token=`)).toBe(true);
    }
  });

  // Break caught: a destination accepted and ignored, which teaches an attacker which field to try next, or accepted and used.
  it('refuses a request that names a destination, creates nothing and counts it as rejected', async () => {
    const { row } = await routes.staffMember();
    const before = routes.excluded('REJECTED');
    for (const extra of [
      { destination: 'attacker@example.test' },
      { email: 'attacker@example.test' },
      { phone: '+233200000000' },
    ]) {
      const answer = await routes.requestRecovery('STAFF', row.workEmail, extra);
      expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(await routes.requestsOf(row.id)).toEqual([]);
    expect(routes.excluded('REJECTED')).toBe(before + 3);
  });

  // Break caught: the request asked from the other surface's pages, or from no configured origin, and answered as one of its own.
  it('holds each type to its own surface’s origin, before anything is examined', async () => {
    const { row } = await routes.staffMember();
    const vendor = await routes.vendor({ secretHash: SOME_SECRET_HASH });
    const wrongStaff = await routes
      .surfaceOf('VENDOR')
      .post(REQUEST, { principal_type: 'STAFF', identifier: row.workEmail });
    const wrongVendor = await routes
      .surfaceOf('STAFF')
      .post(REQUEST, { principal_type: 'VENDOR', identifier: vendor.row.accountIdentifier });
    const foreign = await routes
      .opsBrowser()
      .post(
        REQUEST,
        { principal_type: 'STAFF', identifier: row.workEmail },
        { origin: 'https://elsewhere.example' },
      );
    for (const answer of [wrongStaff, wrongVendor, foreign]) {
      expect([answer.status, codeOf(answer)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    }
    expect(await routes.requestsOf(row.id)).toEqual([]);
    expect(await routes.requestsOf(vendor.row.accountId)).toEqual([]);
  });

  it('refuses a rider, which has no self-service path, and an identifier that cannot be one of its type', async () => {
    const rider = await routes
      .opsBrowser()
      .post(REQUEST, { principal_type: 'RIDER', identifier: '+233201234567' });
    const notAnEmail = await routes.requestRecovery('STAFF', 'not an address');
    const notAnAccount = await routes.requestRecovery('VENDOR', 'not-an-account');
    for (const answer of [rider, notAnEmail, notAnAccount]) {
      expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });
});

describe('a request discloses nothing (AC-SLICE-000-21, AC-SLICE-000-107)', () => {
  // Break caught: an answer that differs for a real principal (a body, a header, a cookie), an event or a row for an unknown one.
  it('answers an unknown identifier exactly as a known one, and records nothing for it', async () => {
    const { row } = await routes.staffMember();
    const vendor = await routes.vendor({ secretHash: SOME_SECRET_HASH });
    const before = routes.excluded('UNKNOWN_OR_INELIGIBLE');
    const auditBefore = (await rows(`select id from audit_event`)).length;

    const known = await routes.requestRecovery('STAFF', row.workEmail);
    const unknown = await routes.requestRecovery('STAFF', 'nobody-at-all@example.test');
    const knownVendor = await routes.requestRecovery('VENDOR', vendor.row.accountIdentifier);
    const unknownVendor = await routes.requestRecovery('VENDOR', accountIdentifier());

    expect(shapeOf(unknown)).toEqual(shapeOf(known));
    expect(shapeOf(unknownVendor)).toEqual(shapeOf(knownVendor));
    expect(shapeOf(known)).toMatchObject({ status: 202, text: '', cookies: [] });
    expect(routes.excluded('UNKNOWN_OR_INELIGIBLE')).toBe(before + 2);
    // Exactly the two events of the two real principals, and nothing for the two that match nobody.
    expect((await rows(`select id from audit_event`)).length).toBe(auditBefore + 2);
  });

  // Break caught: a provider called on the response path, or the request and its message written after the answer (or not at all).
  it('has committed the request and its message before the answer, with no worker running', async () => {
    const { row } = await routes.staffMember();
    const answer = await routes.requestRecovery('STAFF', row.workEmail);
    expect(answer.status).toBe(202);
    const [request] = await routes.requestsOf(row.id);
    expect(request).toMatchObject({ state: 'PENDING', job: 'QUEUED' });
    expect(
      await rows(
        `select attempt_count from credential_delivery_job where redemption_record_id = $1`,
        [request?.id],
      ),
    ).toEqual([{ attempt_count: 0 }]);
  });

  // Diagnosis, not equality: the two branches do bounded work of the same order (the known one locks, reads and writes; the unknown one
  // reads), and neither is padded. The medians are compared within a factor that only an unbounded branch would exceed.
  it('does work of the same order for a known and an unknown identifier', async () => {
    const timed = async (identifier: string): Promise<number> => {
      const started = performance.now();
      const answer = await routes.requestRecovery('STAFF', identifier);
      expect(answer.status).toBe(202);
      return performance.now() - started;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      // A fresh principal each round, so that every known request is issued (none is coalesced) and none is limited.
      const { row } = await routes.staffMember();
      known.push(await timed(row.workEmail));
      unknown.push(await timed(`nobody-${String(round)}-${row.id.slice(0, 8)}@example.test`));
    }
    const median = (values: number[]) =>
      values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    const ratio = median(known) / Math.max(median(unknown), 1);
    expect(
      ratio,
      `known ${known.map(Math.round).join(',')} ms, unknown ${unknown.map(Math.round).join(',')} ms`,
    ).toBeLessThan(20);
    expect(1 / ratio).toBeLessThan(20);
  });
});

describe('the limit (AC-SLICE-000-104)', () => {
  // Break caught: a limit that a real principal meets and an unknown one does not (or the reverse), one keyed on the text as typed, or a
  // coalesced request that does not count.
  it('limits a real principal and an unknown identifier alike, ten a minute, every request counted', async () => {
    const { row } = await routes.staffMember();
    const before = routes.excluded('RATE_LIMITED');
    for (const identifier of [row.workEmail, 'never-registered@example.test']) {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        // The case and the padding vary; the canonical form, and so the bucket, does not.
        const typed = attempt % 2 === 0 ? identifier.toUpperCase() : ` ${identifier}`;
        expect((await routes.requestRecovery('STAFF', typed)).status).toBe(202);
      }
      const limited = await routes.requestRecovery('STAFF', identifier);
      expect([limited.status, codeOf(limited)]).toEqual([429, 'RATE_LIMITED']);
    }
    expect(routes.excluded('RATE_LIMITED')).toBe(before + 2);
    // Ten requests for the real principal: one issued, nine coalesced inside the guard, each with its one event.
    expect((await routes.requestsOf(row.id)).length).toBe(1);
    expect((await eventsFor(row.id)).map((event) => event.resulting_state)).toEqual([
      'ISSUED',
      ...Array<string>(9).fill('COALESCED'),
    ]);
    // Another identifier has a bucket of its own.
    expect((await routes.requestRecovery('STAFF', 'someone-else@example.test')).status).toBe(202);
  });
});

describe('a repeated request (AC-SLICE-000-121, request half)', () => {
  // Break caught: a second request inside the guard that supersedes the pending link, issues another, or answers differently.
  it('coalesces a request inside the guard onto the pending link, which stays usable', async () => {
    const { row } = await routes.staffMember();
    const first = await routes.requestRecovery('STAFF', row.workEmail);
    const second = await routes.requestRecovery('STAFF', row.workEmail);
    expect(shapeOf(second)).toEqual(shapeOf(first));
    const requests = await routes.requestsOf(row.id);
    expect(requests).toEqual([expect.objectContaining({ state: 'PENDING', job: 'QUEUED' })]);
    expect(await eventsFor(row.id)).toEqual([
      expect.objectContaining({
        object_id: requests[0]?.id,
        resulting_state: 'ISSUED',
        actor_type: 'SYSTEM',
        enhanced: false,
      }),
      expect.objectContaining({
        object_id: requests[0]?.id,
        resulting_state: 'COALESCED',
        actor_type: 'SYSTEM',
        enhanced: false,
      }),
    ]);
  });

  // Break caught: a link past the guard that invalidates the earlier one, a third live link, or a coalesced request that issues one.
  it('issues a second link once the guard has passed, leaving the first usable, and coalesces at two', async () => {
    const { row } = await routes.staffMember();
    await routes.requestRecovery('STAFF', row.workEmail);
    const [first] = await routes.requestsOf(row.id);
    await age(first?.id ?? '', 61);

    await routes.requestRecovery('STAFF', row.workEmail);
    const two = await routes.requestsOf(row.id);
    expect(two.map((each) => each.state)).toEqual(['PENDING', 'PENDING']);
    await age(two[1]?.id ?? '', 61);

    const third = await routes.requestRecovery('STAFF', row.workEmail);
    expect(third.status).toBe(202);
    expect((await routes.requestsOf(row.id)).map((each) => each.state)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    const events = await eventsFor(row.id);
    expect(events.map((event) => event.resulting_state)).toEqual(['ISSUED', 'ISSUED', 'COALESCED']);
    // The coalesced event names the newest live link.
    expect(events[2]?.object_id).toBe(two[1]?.id);
  });

  // Break caught: a link whose message was never delivered counted toward the cap, so the next request is coalesced onto a dead one.
  it('does not count a link whose message ended FAILED or CANCELLED', async () => {
    const { row } = await routes.staffMember();
    await routes.requestRecovery('STAFF', row.workEmail);
    const [first] = await routes.requestsOf(row.id);
    await age(first?.id ?? '', 61);
    await routes.requestRecovery('STAFF', row.workEmail);
    const [, second] = await routes.requestsOf(row.id);
    await age(second?.id ?? '', 61);
    await endMessage(first?.id ?? '', 'FAILED');

    await routes.requestRecovery('STAFF', row.workEmail);
    const after = await routes.requestsOf(row.id);
    expect(after).toHaveLength(3);
    expect(after[2]).toMatchObject({ state: 'PENDING', job: 'QUEUED' });
    await age(after[2]?.id ?? '', 61);
    await endMessage(second?.id ?? '', 'CANCELLED');
    await routes.requestRecovery('STAFF', row.workEmail);
    expect(await routes.requestsOf(row.id)).toHaveLength(4);
  });

  // Break caught: the cap judged outside the identity's lock, so that two requests arriving together each see one live link and both issue.
  it('makes at most two live links of two requests that arrive together when one is live', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { row } = await routes.staffMember();
      await routes.requestRecovery('STAFF', row.workEmail);
      const [first] = await routes.requestsOf(row.id);
      await age(first?.id ?? '', 61);
      const answers = await Promise.all([
        routes.requestRecovery('STAFF', row.workEmail),
        routes.requestRecovery('STAFF', row.workEmail),
      ]);
      expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
      expect(
        (await routes.requestsOf(row.id)).filter((each) => each.state === 'PENDING'),
      ).toHaveLength(2);
    }
  });

  // Break caught: an event that holds what was typed, the address, or the token; or a grant-issue event written for a recovery.
  it('records the request in one event that names the principal and the channel, and nothing typed or sent', async () => {
    const { row } = await routes.staffMember();
    await routes.requestRecovery('STAFF', row.workEmail.toUpperCase());
    const [request] = await routes.requestsOf(row.id);
    const message = await routes.deliveredFor(routes.admin, request?.id ?? '');
    const [event] = await rows<Record<string, unknown>>(
      `select * from audit_event where event_code = 'auth.recovery.requested' and object_id = $1`,
      [request?.id],
    );
    expect(event).toMatchObject({
      actor_type: 'SYSTEM',
      actor_id: null,
      object_type: 'RecoveryRequest',
      resulting_state: 'ISSUED',
      related_ids: { principal_type: 'STAFF', principal_id: row.id },
      detail: { channel: 'EMAIL' },
    });
    const everything = JSON.stringify(await rows(`select * from audit_event`));
    for (const secret of [
      row.workEmail,
      row.workEmail.toUpperCase(),
      message?.token ?? 'no token',
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(
      await rows(
        `select id from audit_event where event_code = 'auth.setup_grant.issued' and object_id = $1`,
        [request?.id],
      ),
    ).toEqual([]);
  });
});

describe('only an eligible principal is sent a link (credential-recovery.md section 5.7)', () => {
  // Break caught: a link sent to a terminal, pending or credential-less identity, or one of them answered differently from an unknown one.
  it('answers an ineligible staff identity exactly as an unknown identifier, and creates nothing', async () => {
    const ineligible = await Promise.all([
      routes.staffMember({ status: 'PENDING_APPROVAL', approvedBy: null }),
      routes.staffMember({ status: 'OFFBOARDED' }),
      routes.staffMember({ credentialHash: null, credentialEstablishedAt: null }),
    ]);
    const rejected = await routes.staffMember({
      status: 'REJECTED',
      credentialHash: null,
      credentialEstablishedAt: null,
    });
    const unknown = await routes.requestRecovery('STAFF', 'nobody-else@example.test');
    const before = routes.excluded('UNKNOWN_OR_INELIGIBLE');
    for (const { row } of [...ineligible, rejected]) {
      const answer = await routes.requestRecovery('STAFF', row.workEmail);
      expect(shapeOf(answer)).toEqual(shapeOf(unknown));
      expect(await routes.requestsOf(row.id)).toEqual([]);
      expect(await eventsFor(row.id)).toEqual([]);
    }
    expect(routes.excluded('UNKNOWN_OR_INELIGIBLE')).toBe(before + 4);
  });

  it('answers a vendor with no secret, or of an organisation that is not ACTIVE or SUSPENDED, as an unknown identifier', async () => {
    const arranged = await Promise.all([
      routes.vendor({ secretHash: null }),
      routes.vendor({ secretHash: SOME_SECRET_HASH, organizationStatus: 'REJECTED' }),
      routes.vendor({ secretHash: SOME_SECRET_HASH, organizationStatus: 'TERMINATED' }),
      routes.vendor({
        secretHash: SOME_SECRET_HASH,
        organizationStatus: 'PENDING_SENIOR_OPS_REVIEW',
      }),
    ]);
    const unknown = await routes.requestRecovery('VENDOR', accountIdentifier());
    for (const { row } of arranged) {
      const answer = await routes.requestRecovery('VENDOR', row.accountIdentifier);
      expect(shapeOf(answer)).toEqual(shapeOf(unknown));
      expect(await routes.requestsOf(row.accountId)).toEqual([]);
      expect(await eventsFor(row.accountId)).toEqual([]);
    }
  });

  // Break caught: a suspension treated as ineligibility (a suspended principal's request proceeds like any other), or lifted by the request.
  it('issues a link to a suspended staff member, a suspended account and an account of a suspended organisation, and lifts nothing', async () => {
    const staff = await routes.staffMember({ status: 'SUSPENDED' });
    const account = await routes.vendor({
      secretHash: SOME_SECRET_HASH,
      accountStatus: 'SUSPENDED',
    });
    const organisation = await routes.vendor({
      secretHash: SOME_SECRET_HASH,
      organizationStatus: 'SUSPENDED',
    });
    expect((await routes.requestRecovery('STAFF', staff.row.workEmail)).status).toBe(202);
    expect((await routes.requestRecovery('VENDOR', account.row.accountIdentifier)).status).toBe(
      202,
    );
    expect(
      (await routes.requestRecovery('VENDOR', organisation.row.accountIdentifier)).status,
    ).toBe(202);
    for (const id of [staff.row.id, account.row.accountId, organisation.row.accountId]) {
      expect(await routes.requestsOf(id)).toEqual([expect.objectContaining({ state: 'PENDING' })]);
    }
    expect(await rows(`select status from staff_identity where id = $1`, [staff.row.id])).toEqual([
      { status: 'SUSPENDED' },
    ]);
    expect(
      await rows(`select status from vendor_account where id = $1`, [account.row.accountId]),
    ).toEqual([{ status: 'SUSPENDED' }]);
    expect(
      await rows(`select operational_status from vendor_organization where id = $1`, [
        organisation.row.organizationId,
      ]),
    ).toEqual([{ operational_status: 'SUSPENDED' }]);
  });
});

describe('a request racing the end of the principal’s access (GBT-B15, request half)', () => {
  /** Holds the row's lock in a second connection, changes it while the request waits, and commits; returns the request's answer. */
  async function whileHeld(
    lock: string,
    change: string,
    id: string,
    waitingOn: RegExp,
    send: () => Promise<TestResponse>,
  ): Promise<TestResponse> {
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(lock, [id]);
      const pending = send();
      await waitUntilBlocked(routes.admin, routes.database.name, waitingOn);
      await holder.query(change, [id]);
      await holder.query('commit');
      return await pending;
    } finally {
      await holder.end();
    }
  }

  // Break caught: eligibility read before the identity's lock, so that a request that waited for an offboarding still sends a link.
  it('excludes a staff identity offboarded while the request waited for its lock, with no event', async () => {
    const { row } = await routes.staffMember();
    const answer = await whileHeld(
      `select 1 from staff_identity where id = $1 for update`,
      `update staff_identity set status = 'OFFBOARDED' where id = $1`,
      row.id,
      /from staff_identity where id = .* for no key update/,
      () => routes.requestRecovery('STAFF', row.workEmail),
    );
    expect(answer.status).toBe(202);
    expect(await routes.requestsOf(row.id)).toEqual([]);
    expect(await eventsFor(row.id)).toEqual([]);
  });

  it('excludes a vendor whose organisation was terminated while the request waited for the account lock, with no event', async () => {
    const { row } = await routes.vendor({ secretHash: SOME_SECRET_HASH });
    const answer = await whileHeld(
      `select 1 from vendor_account where id = $1 for update`,
      `update vendor_organization set operational_status = 'TERMINATED'
        where id = (select vendor_organization_id from vendor_account where id = $1)`,
      row.accountId,
      /from vendor_account where id = .* for no key update/,
      () => routes.requestRecovery('VENDOR', row.accountIdentifier),
    );
    expect(answer.status).toBe(202);
    expect(await routes.requestsOf(row.accountId)).toEqual([]);
    expect(await eventsFor(row.accountId)).toEqual([]);
  });

  // The other order: a request judged before the offboarding is ISSUED; its completion is refused by S0.51's test of that half.
  it('issues the link of a request judged before the offboarding', async () => {
    const { row } = await routes.staffMember();
    expect((await routes.requestRecovery('STAFF', row.workEmail)).status).toBe(202);
    await routes.admin.query(`update staff_identity set status = 'OFFBOARDED' where id = $1`, [
      row.id,
    ]);
    expect(await routes.requestsOf(row.id)).toEqual([
      expect.objectContaining({ state: 'PENDING' }),
    ]);
    expect((await eventsFor(row.id)).map((event) => event.resulting_state)).toEqual(['ISSUED']);
  });
});
