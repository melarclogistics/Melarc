import { describe, expect, it } from 'vitest';

import { normalizeStatement, sameShape, traceStatements, WorkShapeError } from './work-shape.js';

/**
 * The work-shape tracer (S0.10): what a database door did, as a sequence of statements with their values taken out, so that two
 * requests whose answers look alike can be compared by what each did (AC-81 and the failure branches of sign-in compare "status,
 * body and statement shape"). The normaliser is pure; the recorder is shown against a driver double here, and against a real
 * server and the real service in the integration kit's own tests.
 */
describe('normalizeStatement', () => {
  // Break caught: values left in the shape, so that two branches differing only in an email, a limit or a timestamp compare
  // as different, or the other way, a shape that ignores which table is read.
  it.each([
    ["select * from staff where email = 'a@b.c'", 'select * from staff where email = ?'],
    ["select * from staff where email = 'it''s'", 'select * from staff where email = ?'],
    ['select * from staff where id = $1 and n > 5', 'select * from staff where id = ? and n > ?'],
    ['update  hub\n   set name = $1\n where id = $2', 'update hub set name = ? where id = ?'],
    [
      'SELECT pg_advisory_xact_lock($1::int4, $2::int4)',
      'select pg_advisory_xact_lock(?::int4, ?::int4)',
    ],
    [
      "begin; select set_config('transaction_timeout', '4000ms', true)",
      'begin; select set_config(?, ?, true)',
    ],
  ])('reduces %j to %j', (statement, shape) => {
    expect(normalizeStatement(statement)).toBe(shape);
  });

  it('keeps the names of the tables and columns, which are the shape', () => {
    expect(normalizeStatement('select a from one')).not.toBe(
      normalizeStatement('select a from two'),
    );
    expect(normalizeStatement('select a from one')).not.toBe(
      normalizeStatement('select b from one'),
    );
  });

  it('does not change a digit that belongs to a name', () => {
    expect(normalizeStatement('select int4_col, t2.x from t2 where y = 12')).toBe(
      'select int4_col, t2.x from t2 where y = ?',
    );
  });
});

describe('sameShape', () => {
  it('compares order and count as well as content', () => {
    expect(sameShape(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameShape(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameShape(['a'], ['a', 'a'])).toBe(false);
    expect(sameShape([], [])).toBe(true);
  });
});

describe('traceStatements', () => {
  interface FakeClient {
    readonly connectionParameters?: { readonly user?: string };
  }
  const clientOf = (user: string): FakeClient => ({ connectionParameters: { user } });

  /** A driver whose `query` answers at once: what the recorder wraps, with no server. */
  function driver() {
    return {
      query: function (this: FakeClient, ...query: unknown[]): Promise<string> {
        return Promise.resolve(`${this.connectionParameters?.user ?? ''}:${String(query.length)}`);
      },
    };
  }

  // Break caught: a tracer that records every connection of the process (the administrator's, the observer's) and so makes a shape
  // out of the test's own bookkeeping.
  it('records only the statements of the role it was asked about, in order, as shapes', async () => {
    const fake = driver();
    const runtime = clientOf('melarc_api_runtime');
    const admin = clientOf('postgres');
    const traced = await traceStatements(
      'melarc_api_runtime',
      async () => {
        await fake.query.call(runtime, 'begin');
        await fake.query.call(admin, 'select 999');
        await fake.query.call(runtime, "select 1 where x = 'a'", []);
        await fake.query.call(runtime, { text: 'commit', values: [] });
      },
      fake,
    );
    expect(traced.statements).toEqual(['begin', 'select ? where x = ?', 'commit']);
  });

  // Break caught: the wrapper changing what the driver does (a value, a `this`, an argument), which would make the traced
  // run behave differently from an untraced one.
  it('leaves the answer of the driver as it was', async () => {
    const fake = driver();
    let answer = '';
    await traceStatements(
      'melarc_api_runtime',
      async () => {
        answer = await fake.query.call(clientOf('melarc_api_runtime'), 'select 1');
      },
      fake,
    );
    expect(answer).toBe('melarc_api_runtime:1');
  });

  // Break caught: a patch left in place after the traced work, which would count every later test's statements and slow them.
  it('puts the driver back when the work ends, whether it returns or throws', async () => {
    const fake = driver();
    const original: unknown = Reflect.get(fake, 'query');
    await traceStatements('melarc_api_runtime', () => Promise.resolve(), fake);
    expect(Reflect.get(fake, 'query')).toBe(original);
    await expect(
      traceStatements(
        'melarc_api_runtime',
        () => Promise.reject(new Error('the work failed')),
        fake,
      ),
    ).rejects.toThrow(/the work failed/);
    expect(Reflect.get(fake, 'query')).toBe(original);
  });

  // Break caught: two traces at once, whose patches would be undone in the wrong order and leave the driver wrapped for good.
  it('refuses a second trace while one is running', async () => {
    const fake = driver();
    let inner: unknown;
    await traceStatements(
      'melarc_api_runtime',
      async () => {
        inner = await traceStatements('melarc_api_runtime', () => Promise.resolve(), fake).catch(
          (error: unknown) => error,
        );
      },
      fake,
    );
    expect(inner).toBeInstanceOf(WorkShapeError);
  });

  it('returns what the traced work returned', async () => {
    const traced = await traceStatements('melarc_api_runtime', () => Promise.resolve(42), driver());
    expect(traced.result).toBe(42);
    expect(traced.statements).toEqual([]);
  });
});
