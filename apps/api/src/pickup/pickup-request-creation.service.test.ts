import { randomUUID } from 'node:crypto';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import type { SecurityContext } from '../platform/database/transaction-context.js';
import { registerTransactionFacts } from '../platform/database/transaction-facts.js';
import { bindTransactionHandle } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import { PickupRequestCreation, type CreatePickupBody } from './pickup-request-creation.service.js';

/**
 * The order in which `createPickupRequest` judges a registered vendor's booking (`AC-SLICE-001-82`; the audit of 7 November 2026, A2): **for a staff caller the
 * organisation's hub is judged against the grant as soon as the organisation is found, before its status, before the hub the body names, and before the
 * configuration of its hub is read**, so that the answer to an officer of one hub naming an organisation of another is the same whatever that organisation
 * is. The route tests see the answers (`pickup-request-creation-routes.db.test.ts`); this reads, on fakes, what the service asked of the database and of
 * the configuration, which an answer cannot show: a refusal given after a read is still a read that was made.
 */
const HUB_A = '11111111-1111-4111-8111-111111111111';
const HUB_B = '22222222-2222-4222-8222-222222222222';
const ORGANISATION = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
/** A Wednesday: a day the hub works. */
const WEDNESDAY = '2026-11-04';

const dialect = new PgDialect();

const CONTEXT: SecurityContext = {
  principalType: 'STAFF',
  principalId: PRINCIPAL,
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'correlation',
};

/** A staff session whose grant of the booking key reaches the hubs given (`SET`), or every hub (`ALL`). */
function staff(hubs: readonly string[] | 'ALL'): AuthorizedRequest {
  return {
    session: { principalType: 'STAFF', principalId: PRINCIPAL },
    scope:
      hubs === 'ALL'
        ? { hubScopeMode: 'ALL', authorizedHubIds: [] }
        : { hubScopeMode: 'SET', authorizedHubIds: hubs },
  } as unknown as AuthorizedRequest;
}

/** A vendor session: its hub is its organisation's and is not a scope it holds. */
const vendorSession = (): AuthorizedRequest =>
  ({
    session: { principalType: 'VENDOR', principalId: PRINCIPAL },
    scope: { hubScopeMode: 'SET', authorizedHubIds: [] },
  }) as unknown as AuthorizedRequest;

interface Organisation {
  readonly hub: string;
  readonly status: string;
}

/**
 * The service over a fake transaction that answers the two reads of the organisation (the hub alone, in the transaction that finds it, and the row, in the
 * booking's) and refuses every other statement, and a configuration reader that notes the hubs it was asked about.
 */
function creation(organisation: Organisation | undefined) {
  const statements: string[] = [];
  const configured: string[] = [];
  const transaction = {
    execute: (statement: SQL) => {
      const text = dialect.sqlToQuery(statement).sql.replaceAll(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.startsWith('select responsible_hub_id from vendor_organization where id = ')) {
        return Promise.resolve({
          rows: organisation === undefined ? [] : [{ responsible_hub_id: organisation.hub }],
        });
      }
      if (text.includes(' from vendor_organization where id = ')) {
        return Promise.resolve({
          rows:
            organisation === undefined
              ? []
              : [
                  {
                    id: ORGANISATION,
                    responsible_hub_id: organisation.hub,
                    operational_status: organisation.status,
                    display_name: 'Zuko Fabrics',
                    contact_phone: null,
                  },
                ],
        });
      }
      return Promise.reject(new Error(`No other statement was expected: ${text}`));
    },
  } as unknown as DatabaseTransaction;
  registerTransactionFacts(transaction, {
    statementsSinceContext: () => statements.length,
    markContextApplied: () => undefined,
    appliedContext: () => CONTEXT,
  });
  const handle = bindTransactionHandle(transaction);
  const runner = {
    mutate: (
      authorized: AuthorizedRequest,
      _correlationId: string,
      work: (handle: unknown, authorized: AuthorizedRequest) => Promise<unknown>,
    ) => work(handle, authorized),
  } as unknown as Pick<OperationRunner, 'mutate'>;
  const idempotency = {
    begin: () => Promise.resolve({ outcome: 'NEW', recordId: randomUUID() }),
  } as unknown as IdempotencyStore;
  const configuration = {
    forHub: (hubId: string) => {
      configured.push(hubId);
      return Promise.resolve({ hubId, hubName: 'Accra' });
    },
  } as unknown as Pick<ConfigurationReader, 'forHub'>;
  const service = new PickupRequestCreation({
    runner,
    audit: {} as AuditWriter,
    idempotency,
    clock: {} as Clock,
    configuration,
  });
  return { service, statements, configured };
}

const registered = (over: Partial<CreatePickupBody> = {}): CreatePickupBody => ({
  pickup_intent: 'OWN_PACKAGES',
  vendor_organization_id: ORGANISATION,
  scheduled_service_date: WEDNESDAY,
  declared_package_count: 3,
  default_payer_intent: 'RECIPIENT_PAYS',
  ...over,
});

async function refusalOf(
  service: PickupRequestCreation,
  authorized: AuthorizedRequest,
  body: CreatePickupBody,
): Promise<ApiException> {
  const caught = await service
    .create(authorized, 'correlation', {
      body,
      idempotencyKey: randomUUID(),
      fingerprint: 'fingerprint',
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(caught, 'the booking was refused').toBeInstanceOf(ApiException);
  return caught as ApiException;
}

/** What a client is told: the code, the status and the words and details the answer carries. */
const answerOf = (refusal: ApiException) => ({
  code: refusal.code,
  status: refusal.getStatus(),
  message: refusal.message,
  details: refusal.details,
});

describe('a staff caller naming an organisation of a hub outside the grant (A2; AC-SLICE-001-82)', () => {
  const WHATEVER_THE_ORGANISATION_IS: readonly (readonly [
    string,
    Organisation,
    Partial<CreatePickupBody>,
  ])[] = [
    ['an active organisation', { hub: HUB_A, status: 'ACTIVE' }, {}],
    ['a suspended organisation', { hub: HUB_A, status: 'SUSPENDED' }, {}],
    ['an organisation that is not active', { hub: HUB_A, status: 'REJECTED' }, {}],
    [
      'an organisation still to be reviewed',
      { hub: HUB_A, status: 'PENDING_SENIOR_OPS_REVIEW' },
      {},
    ],
    [
      'an active organisation, with a hub named that is the officer’s own',
      { hub: HUB_A, status: 'ACTIVE' },
      { hub_id: HUB_B },
    ],
    [
      'a suspended organisation, with a hub named that is not its hub',
      { hub: HUB_A, status: 'SUSPENDED' },
      { hub_id: HUB_B },
    ],
    [
      'a suspended organisation, in a collection for it',
      { hub: HUB_A, status: 'SUSPENDED' },
      { pickup_intent: 'COLLECT_FOR_VENDOR' },
    ],
  ];

  // Break caught: the status of the organisation (SENDER_SUSPENDED, or a validation failure for one that is not active) or the hub the body names (a
  // validation failure of /hub_id) judged before the scope, which tells an officer of one hub the status of another hub's organisation and whether the hub
  // they named is its hub; or the scope answered in different words for different organisations.
  it.each(WHATEVER_THE_ORGANISATION_IS)(
    'is told it is outside their hubs for %s, and nothing of the organisation',
    async (_what, organisation, over) => {
      const { service } = creation(organisation);

      const refusal = await refusalOf(service, staff([HUB_B]), registered(over));

      expect(answerOf(refusal)).toEqual({
        code: 'HUB_SCOPE_VIOLATION',
        status: 403,
        message: 'The booking is outside your hubs',
        details: undefined,
      });
    },
  );

  it('is told the same for every organisation, word for word', async () => {
    const answers = [];
    for (const [, organisation, over] of WHATEVER_THE_ORGANISATION_IS) {
      const { service } = creation(organisation);
      answers.push(answerOf(await refusalOf(service, staff([HUB_B]), registered(over))));
    }

    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  // Break caught: the configuration of a hub outside the grant read for a caller who was never going to book there (a read that can fail, or take a
  // different time, for a hub the caller must learn nothing of), or a statement beyond the two reads of the organisation made before the refusal.
  it('reads the configuration of no hub outside their grant, and nothing but the organisation, before refusing', async () => {
    const { service, statements, configured } = creation({ hub: HUB_A, status: 'SUSPENDED' });

    await refusalOf(service, staff([HUB_B]), registered());

    expect(configured).toEqual([]);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(
      /^select responsible_hub_id from vendor_organization where id = /,
    );
    expect(statements[1]).toMatch(/ from vendor_organization where id = /);
  });

  // Break caught: the scope judged after a read of the organisation's facts for an officer whose grant reaches the hub, which would be the same defect the
  // other way round, or a scope that is judged on the first hub of the grant and not on all of them.
  it('is judged against every hub of the grant, and a hub of the grant is an organisation they may be told about', async () => {
    const { service, configured } = creation({ hub: HUB_A, status: 'SUSPENDED' });

    const refusal = await refusalOf(service, staff([HUB_B, HUB_A]), registered());

    expect(refusal.code).toBe('SENDER_SUSPENDED');
    expect(configured).toEqual([HUB_A]);
  });
});

describe('a caller who may be told about the organisation is told as before', () => {
  // Break caught: the scope check put in front of the facts for callers it does not concern, or the facts no longer judged in their order (the status of
  // the organisation, then the hub the body names) for the officer of its own hub, a session of every hub and a vendor of the organisation.
  it.each([
    ['an officer of its hub', () => staff([HUB_A])],
    ['a session of every hub', () => staff('ALL')],
    ['a vendor of the organisation', vendorSession],
  ])('is told its status, then the hub it named, as %s', async (_who, authorized) => {
    const suspended = await refusalOf(
      creation({ hub: HUB_A, status: 'SUSPENDED' }).service,
      authorized(),
      registered(),
    );
    expect([suspended.code, suspended.getStatus()]).toEqual(['SENDER_SUSPENDED', 422]);

    const inactive = await refusalOf(
      creation({ hub: HUB_A, status: 'REJECTED' }).service,
      authorized(),
      registered(),
    );
    expect(inactive.code).toBe('VALIDATION_FAILED');
    expect(inactive.details).toEqual({
      violations: [{ in: 'body', pointer: '/vendor_organization_id', rule: 'enum' }],
    });

    const elsewhere = await refusalOf(
      creation({ hub: HUB_A, status: 'ACTIVE' }).service,
      authorized(),
      registered({ hub_id: HUB_B }),
    );
    expect(elsewhere.code).toBe('VALIDATION_FAILED');
    expect(elsewhere.details).toEqual({
      violations: [{ in: 'body', pointer: '/hub_id', rule: 'enum' }],
    });
  });

  it('is told an organisation that does not exist is not one it can book for, as before', async () => {
    const refusal = await refusalOf(creation(undefined).service, staff([HUB_B]), registered());

    expect(refusal.code).toBe('VALIDATION_FAILED');
    expect(refusal.details).toEqual({
      violations: [{ in: 'body', pointer: '/vendor_organization_id', rule: 'enum' }],
    });
  });
});
