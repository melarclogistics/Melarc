import { describe, expect, it } from 'vitest';

import type { DatabaseTransaction } from './database.service.js';
import { registerTransactionFacts, transactionFacts } from './transaction-facts.js';
import { bindTransactionHandle, securityContextOf, transactionOf } from './transaction-handle.js';
import { frozenContextCopy, type SecurityContext } from './transaction-context.js';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: ['22222222-2222-4222-8222-222222222222'],
  correlationId: 'request-1',
};

/**
 * A transaction as the database service leaves it once the context statement has run: its facts are registered, and the context it
 * applied is among them. (The service is the only code that registers facts; the bridge reads only what the service said.)
 */
const registered = (): DatabaseTransaction => {
  const tx = {} as DatabaseTransaction;
  let held: SecurityContext | undefined;
  registerTransactionFacts(tx, {
    statementsSinceContext: () => 0,
    markContextApplied: (context) => {
      held = context;
    },
    appliedContext: () => held,
  });
  return tx;
};
const opened = (applied: SecurityContext = STAFF): DatabaseTransaction => {
  const tx = registered();
  transactionFacts(tx)?.markContextApplied(applied);
  return tx;
};

describe('the transaction handle', () => {
  // Break caught: a handle that is the transaction itself, which would let any port adapter run a query builder it was never given.
  it('is not the transaction, and hands the transaction back to the code that owns the queries', () => {
    const tx = opened();
    const handle = bindTransactionHandle(tx);

    expect(handle).not.toBe(tx);
    expect(transactionOf(handle)).toBe(tx);
  });

  // Break caught: the handle forgetting the context its transaction was opened under (the audit actor and surface come from it).
  it('carries the security context the transaction was opened under', () => {
    const handle = bindTransactionHandle(opened());

    expect(securityContextOf(handle)).toEqual(STAFF);
  });

  // Break caught (review of 10 October 2026, finding 6): a handle whose context is what its binder claims, not what the database
  // service applied, so that a STAFF-labelled handle could stand over a SYSTEM transaction (or the reverse).
  it('takes the context from the database service, and from nobody who binds it', () => {
    const system: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: '66666666-6666-4666-8666-666666666666',
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: 'request-3',
    };

    // The bridge has no place for a context of the binder's: a second argument is not read.
    const handle = (
      bindTransactionHandle as (tx: DatabaseTransaction, claim?: SecurityContext) => never
    )(opened(system), STAFF);

    expect(securityContextOf(handle).principalType).toBe('SYSTEM');
  });

  // Break caught: a handle for a transaction the service did not open, or has not yet put under a context: no statement of it has the
  // protection of a context, and the audit would have no actor to record.
  it('refuses a transaction the service has not put under a context', () => {
    expect(() => bindTransactionHandle({} as DatabaseTransaction)).toThrow('security context');
    // Registered, but the context statement has not run yet.
    expect(() => bindTransactionHandle(registered())).toThrow('security context');
  });

  // Break caught: a context held by reference, so that a later change by the caller changes who the audit says acted.
  it('holds the frozen copy of the context that the service took, so nobody can change it afterwards', () => {
    const mutable = { ...STAFF, authorizedHubIds: [...(STAFF.authorizedHubIds ?? [])] };
    // What the service registers is its own copy, taken when it validated the context (`frozenContextCopy`).
    const handle = bindTransactionHandle(opened(frozenContextCopy(mutable)));

    (mutable as { principalId: string }).principalId = '99999999-9999-4999-8999-999999999999';
    mutable.authorizedHubIds.push('33333333-3333-4333-8333-333333333333');

    const held = securityContextOf(handle);
    expect(held.principalId).toBe(STAFF.principalId);
    expect(held.authorizedHubIds).toEqual(STAFF.authorizedHubIds);
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held.authorizedHubIds)).toBe(true);
  });

  // Break caught: a second handle for one transaction, which would let two adapters believe they held different transactions.
  it('is one handle for one transaction', () => {
    const tx = opened();

    expect(bindTransactionHandle(tx)).toBe(bindTransactionHandle(tx));
  });

  // Break caught: an object that merely looks like a handle being accepted, so an adapter could be pointed at any query object.
  it('refuses anything that was not made here', () => {
    for (const forged of [{}, Object.freeze({}), null, undefined, 'handle', 7]) {
      expect(() => transactionOf(forged as never)).toThrow('not a transaction handle');
      expect(() => securityContextOf(forged as never)).toThrow('not a transaction handle');
    }
  });

  // Break caught: a handle whose transaction can no longer be reached being the same as a handle that was never made.
  it('is no key to the transaction for a handle made for another one', () => {
    const first = opened();
    const second = opened();
    const handle = bindTransactionHandle(first);

    expect(transactionOf(handle)).not.toBe(second);
  });
});
