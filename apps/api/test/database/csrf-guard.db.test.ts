import { randomUUID } from 'node:crypto';

import { Controller, Delete, Get, Head, Module, Patch, Post, Put } from '@nestjs/common';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import { DescribeSecurity } from '../../src/platform/openapi/operation-statements.js';
import {
  Anonymous,
  RequiresPermission,
  Self,
} from '../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { RawClient } from '../../src/test-support/raw-http.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertSessionRow, sessionRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery, type StaffPersona } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { EVERY_SURFACE } from '../../src/test-support/route-options.js';

/**
 * CSRF, Origin and Fetch Metadata over real HTTP and a real database (S0.25; SECURITY_DESIGN.md §13.8; `GBT-W5` to `GBT-W7`,
 * `GBT-W10` to `GBT-W12`, `GBT-W15`; `AC-SLICE-000-130`). The application is the one that ships, with fixture routes added; the
 * sessions are issued by the real protocol; what was recorded is read from a second connection.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let observer: Observer;
let machinery: Machinery;
let app: TestApp;
/** The two configured origins, read from the same configuration the application is started with (they do not depend on the database). */
const origins = (() => {
  const loaded = loadConfig(validEnv());
  if (!loaded.ok) throw new Error('the configuration was refused');
  return loaded.config.origins;
})();
const OPS = origins.ops;
const VENDOR = origins.vendor;
let handled = 0;

const hit = (): { served: true } => {
  handled += 1;
  return { served: true };
};

@Controller('csrf')
class CsrfController {
  // Browser pre-session mutations: one per surface, and the default (both).
  @Post('ops-only')
  @Anonymous(undefined, { kind: 'browser', surfaces: ['OPS_PORTAL'] })
  opsOnly(): { served: true } {
    return hit();
  }

  @Post('vendor-only')
  @Anonymous(undefined, { kind: 'browser', surfaces: ['VENDOR_PWA'] })
  vendorOnly(): { served: true } {
    return hit();
  }

  @Post('both')
  @Anonymous()
  both(): { served: true } {
    return hit();
  }

  // The native Rider operations: no Origin required, and none refused for lacking it.
  @Post('native')
  @Anonymous(undefined, { kind: 'native' })
  native(): { served: true } {
    return hit();
  }

  @Get('open')
  @Anonymous()
  openRead(): { served: true } {
    return hit();
  }

  @Head('open')
  @Anonymous()
  openHead(): { served: true } {
    return hit();
  }

  // Authenticated routes. The default posture takes a browser session (with its token) or a rider session.
  @Get('read')
  @Self(EVERY_SURFACE)
  read(): { served: true } {
    return hit();
  }

  @Post('write')
  @Self(EVERY_SURFACE)
  write(): { served: true } {
    return hit();
  }

  @Put('write')
  @Self(EVERY_SURFACE)
  writePut(): { served: true } {
    return hit();
  }

  @Patch('write')
  @Self(EVERY_SURFACE)
  writePatch(): { served: true } {
    return hit();
  }

  @Delete('write')
  @Self(EVERY_SURFACE)
  writeDelete(): { served: true } {
    return hit();
  }

  @Post('permission')
  @RequiresPermission('staff.read', EVERY_SURFACE)
  permission(): { served: true } {
    return hit();
  }

  // The Rider's own operation takes only the bearer credential; a browser operation takes only the cookie.
  @Post('rider-only')
  @Self(EVERY_SURFACE)
  @DescribeSecurity(['riderSession'])
  riderOnly(): { served: true } {
    return hit();
  }

  @Post('browser-only')
  @Self(EVERY_SURFACE)
  @DescribeSecurity(['browserSession', 'csrfToken'])
  browserOnly(): { served: true } {
    return hit();
  }
}

@Module({ controllers: [CsrfController] })
class CsrfModule {}

@Module({})
class Root {}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
  machinery = assemble(built);
  const loaded = loadConfig(
    validEnv({ DATABASE_URL: database.urlFor(API_RUNTIME_ROLE), DATABASE_POOL_MAX: '3' }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  app = await startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      // A Vendor or Rider session is served only by an instance that declares the revision of the compiled rules it runs (S0.26).
      Module({
        imports: [
          AppModule.register({ ...options, compiledFixedPolicy: { VENDOR: 1, RIDER: 1 } }),
          CsrfModule,
        ],
      })(Root);
      return Root;
    },
    allowUnsoundRoutes: true,
  });
});

afterAll(async () => {
  await app.stop();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

beforeEach(() => {
  handled = 0;
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '{}',
): Promise<Answer> {
  handled = 0;
  const response = await fetch(`${app.baseUrl}/api/v1/csrf/${path}`, {
    method,
    headers: {
      ...headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The refusal every cause shares: one status, one code, one fixed text. */
const REFUSED = {
  status: 403,
  body: expect.objectContaining({
    code: 'CSRF_VALIDATION_FAILED',
    message: 'CSRF validation failed',
  }) as unknown,
};
const without = (headers: Record<string, string>, name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([key]) => key !== name));
const refused = (answer: Answer): boolean =>
  answer.status === 403 && answer.body.code === 'CSRF_VALIDATION_FAILED';

interface RejectionRow {
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly object_type: string | null;
  readonly object_id: string | null;
  readonly outcome: string;
  readonly enhanced: boolean;
  readonly detail: { route?: string; check?: string };
}
const rejections = (): Promise<RejectionRow[]> =>
  observer.rows<RejectionRow>(
    `select actor_type, actor_id, object_type, object_id, outcome, enhanced, detail
       from audit_event where event_code = 'auth.csrf.rejected' order by recorded_at, id`,
  );

describe('a browser pre-session mutation: the exact Origin of its surface (GBT-W5, GBT-W11)', () => {
  it('is served with the Origin of a surface the route names', async () => {
    expect((await call('POST', 'ops-only', { origin: OPS })).status).toBe(201);
    expect((await call('POST', 'vendor-only', { origin: VENDOR })).status).toBe(201);
    expect(handled).toBe(1);
  });

  // Break caught: the allowlist read as the union of both surfaces for a route that serves one, which lets a Vendor page act as the Ops Portal.
  it('refuses the Origin of the other surface', async () => {
    expect(refused(await call('POST', 'ops-only', { origin: VENDOR }))).toBe(true);
    expect(refused(await call('POST', 'vendor-only', { origin: OPS }))).toBe(true);
    expect(handled).toBe(0);
  });

  it('takes either configured Origin on a route that serves both surfaces', async () => {
    expect((await call('POST', 'both', { origin: OPS })).status).toBe(201);
    expect((await call('POST', 'both', { origin: VENDOR })).status).toBe(201);
  });

  // Break caught: any one of these served. Each is a form of "no valid Origin" that an attacker's page, a sandboxed frame or a
  // script can produce, and the answer to all of them is one and the same.
  it.each<[string, Record<string, string>, string]>([
    ['no Origin', {}, 'ORIGIN_MISSING'],
    ['the null origin', { origin: 'null' }, 'ORIGIN_NULL'],
    ['an unrelated origin', { origin: 'https://evil.example' }, 'ORIGIN_UNLISTED'],
    ['the Ops origin with a longer host', { origin: `${OPS}.evil.example` }, 'ORIGIN_UNLISTED'],
    ['the Ops origin with a trailing slash', { origin: `${OPS}/` }, 'ORIGIN_MALFORMED'],
    ['the Ops origin with a path', { origin: `${OPS}/app` }, 'ORIGIN_MALFORMED'],
    ['the Ops origin in upper case', { origin: OPS.toUpperCase() }, 'ORIGIN_MALFORMED'],
    ['a list of both origins', { origin: `${OPS}, ${VENDOR}` }, 'ORIGIN_MALFORMED'],
    ['an empty Origin', { origin: '' }, 'ORIGIN_MALFORMED'],
  ])(
    'refuses %s with 403 CSRF_VALIDATION_FAILED and records the check',
    async (_label, headers, check) => {
      const before = (await rejections()).length;

      const answer = await call('POST', 'ops-only', headers);

      expect(answer).toMatchObject(REFUSED);
      expect(Object.keys(answer.body).toSorted()).toEqual(['code', 'message', 'request_id']);
      expect(handled).toBe(0);
      const after = await rejections();
      expect(after).toHaveLength(before + 1);
      // A pre-session refusal names no principal and no object: none that does not exist is invented.
      expect(after.at(-1)).toEqual({
        actor_type: 'SYSTEM',
        actor_id: null,
        object_type: 'Session',
        object_id: null,
        outcome: 'REJECTED',
        enhanced: false,
        detail: { route: 'POST /api/v1/csrf/ops-only', check },
      });
    },
  );

  // Break caught: the second Origin line ignored, or read as one joined value.
  it('refuses two Origin lines, even when one is the right one', async () => {
    const client = await RawClient.connect(app.baseUrl);
    try {
      await client.write(
        `POST /api/v1/csrf/ops-only HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${OPS}\r\nOrigin: https://evil.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      const response = await client.read();

      expect(response.status).toBe(403);
      expect(response.json?.code).toBe('CSRF_VALIDATION_FAILED');
      expect(handled).toBe(0);
    } finally {
      client.destroy();
    }
  });

  // Break caught (GBT-W15): Fetch Metadata not consulted, so that a cross-site browser request that carries the right Origin text
  // is served; or a client that sends none refused for it.
  it.each<[string, string | undefined, boolean]>([
    ['cross-site', 'cross-site', false],
    ['same-site', 'same-site', false],
    ['none', 'none', false],
    ['an unknown value', 'cross-origin', false],
    ['same-origin', 'same-origin', true],
    ['no header at all', undefined, true],
  ])('with Sec-Fetch-Site %s is %s', async (_label, site, served) => {
    const answer = await call('POST', 'ops-only', {
      origin: OPS,
      ...(site === undefined ? {} : { 'sec-fetch-site': site }),
    });

    expect(refused(answer)).toBe(!served);
    expect(handled).toBe(served ? 1 : 0);
  });

  it('records a Fetch Metadata refusal as that check and nothing of the header', async () => {
    await call('POST', 'ops-only', { origin: OPS, 'sec-fetch-site': 'cross-site' });

    expect((await rejections()).at(-1)?.detail).toEqual({
      route: 'POST /api/v1/csrf/ops-only',
      check: 'FETCH_METADATA',
    });
  });

  // Break caught (GBT-W12): the native route held to the browser rule, which would refuse the Rider app; or the browser rule
  // dropped for every anonymous route, which would leave the pre-session browser flows undefended.
  it('does not require an Origin of a native operation, and does not judge one it carries', async () => {
    expect((await call('POST', 'native')).status).toBe(201);
    expect((await call('POST', 'native', { origin: 'https://evil.example' })).status).toBe(201);
    expect((await call('POST', 'native', { origin: 'null' })).status).toBe(201);
    expect(handled).toBe(1);
  });

  // Break caught (GBT-W12): a client-type string, or a User-Agent, accepted as proof that the caller is native.
  it('is not made native by anything the caller says about itself', async () => {
    const claims: Record<string, string>[] = [
      { 'user-agent': 'MelarcRider/1.0 (Android 14)' },
      { 'x-client-type': 'native' },
      { 'x-melarc-client': 'rider' },
    ];
    for (const headers of claims) {
      expect(refused(await call('POST', 'ops-only', headers))).toBe(true);
    }
    expect(handled).toBe(0);
  });

  // Break caught: a safe request given a blanket Origin requirement (GBT-W10 and the probes).
  it('puts no Origin requirement on a read, a head or a probe', async () => {
    expect((await call('GET', 'open')).status).toBe(200);
    expect((await call('HEAD', 'open')).status).toBe(200);
    const probe = await fetch(`${app.baseUrl}/livez`);
    expect(probe.status).toBe(200);
  });
});

describe('a cookie-authenticated mutation: the Origin of the session, its token and Fetch Metadata (GBT-W6)', () => {
  let staff: StaffPersona;
  let other: StaffPersona;

  beforeAll(async () => {
    staff = await staffPersona(machinery, admin);
    other = await staffPersona(machinery, admin);
  });

  const csrf = (persona: StaffPersona): string => persona.issued.csrfToken ?? '';
  const withToken = (
    persona: StaffPersona,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    cookie: persona.cookie,
    origin: OPS,
    'x-csrf-token': csrf(persona),
    ...extra,
  });

  // `CSRF_VALIDATION_FAILED` is the only thing these assertions need: the slot after this one is refused or served by the
  // authorization task, and what follows the CSRF slot is not this test's subject.
  it('is not refused by the CSRF slot with the session’s own token and Origin, on every unsafe method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(refused(await call(method, 'write', withToken(staff)))).toBe(false);
    }
  });

  // Break caught (GBT-W6): the token not required, or required only when the Origin is bad.
  it('refuses every unsafe method with no token', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(refused(await call(method, 'write', without(withToken(staff), 'x-csrf-token')))).toBe(
        true,
      );
    }
    expect(handled).toBe(0);
  });

  // Break caught: a token that is some session's accepted for this one, or a hash accepted as the token.
  it.each<[string, () => string]>([
    ['the token of another session', () => csrf(other)],
    ['a token nobody was issued', () => 'A'.repeat(43)],
    ['something that is not a token', () => 'not-a-token'],
    ['an empty token', () => ''],
    [
      'the session’s token with a character changed',
      () => `${csrf(staff).slice(0, 42)}${csrf(staff).endsWith('A') ? 'B' : 'A'}`,
    ],
    ['the session’s token in upper case', () => csrf(staff).toUpperCase()],
  ])('refuses %s', async (_label, token) => {
    const answer = await call('POST', 'write', withToken(staff, { 'x-csrf-token': token() }));

    expect(refused(answer)).toBe(true);
    expect(handled).toBe(0);
  });

  it('refuses the token when it is sent only in the cookie and not echoed in the header', async () => {
    expect(refused(await call('POST', 'write', without(withToken(staff), 'x-csrf-token')))).toBe(
      true,
    );
  });

  // Break caught: the right token excusing a wrong Origin, which is exactly what a page on another origin has when it has read the
  // token. The Origin of a session is its own surface's: a staff session on the Vendor origin is refused (GBT-W1, GBT-W2).
  it.each<[string, Record<string, string>]>([
    ['an empty Origin', { origin: '' }],
    ['the null origin', { origin: 'null' }],
    ['the Vendor origin for a staff session', { origin: VENDOR }],
    ['an unrelated origin', { origin: 'https://evil.example' }],
  ])('refuses the right token with %s', async (_label, extra) => {
    const headers = withToken(staff, extra);

    expect(refused(await call('POST', 'write', headers))).toBe(true);
    expect(handled).toBe(0);
  });

  it('refuses the right token and Origin when the browser says the request is cross-site', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(
        refused(await call('POST', 'write', withToken(staff, { 'sec-fetch-site': site }))),
      ).toBe(true);
    }
    expect(
      refused(await call('POST', 'write', withToken(staff, { 'sec-fetch-site': 'same-origin' }))),
    ).toBe(false);
  });

  it('names the session and the principal in what it records, never the token or its hash', async () => {
    const victim = await staffPersona(machinery, admin);
    const before = (await rejections()).length;

    await call('POST', 'write', withToken(victim, { 'x-csrf-token': 'A'.repeat(43) }));

    const rows = await observer.rows<RejectionRow & { id: string }>(
      `select id, actor_type, actor_id, object_type, object_id, outcome, enhanced, detail from audit_event
        where event_code = 'auth.csrf.rejected' order by recorded_at, id`,
    );
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actor_type: 'STAFF',
      actor_id: victim.identity.id,
      object_type: 'Session',
      object_id: victim.issued.session.id,
      outcome: 'REJECTED',
      enhanced: false,
      detail: { route: 'POST /api/v1/csrf/write', check: 'TOKEN_MISMATCH' },
    });
    // Neither the token the session holds, the one that was sent, nor the hash of either is anywhere in the record.
    const everything = JSON.stringify(
      await observer.rows(`select * from audit_event where event_code = 'auth.csrf.rejected'`),
    );
    for (const secret of [
      csrf(victim),
      'A'.repeat(43),
      Buffer.from(victim.issued.session.csrfTokenHash ?? []).toString('hex'),
      victim.issued.token,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('records the check that failed first, in the order Origin, Fetch Metadata, token', async () => {
    await call('POST', 'write', {
      cookie: staff.cookie,
      origin: 'null',
      'sec-fetch-site': 'cross-site',
    });
    expect((await rejections()).at(-1)?.detail.check).toBe('ORIGIN_NULL');

    await call('POST', 'write', {
      cookie: staff.cookie,
      origin: OPS,
      'sec-fetch-site': 'cross-site',
    });
    expect((await rejections()).at(-1)?.detail.check).toBe('FETCH_METADATA');

    await call('POST', 'write', { cookie: staff.cookie, origin: OPS });
    expect((await rejections()).at(-1)?.detail.check).toBe('TOKEN_MISSING');
  });

  // Break caught (GBT-W10): a read refused for want of a token.
  it('does not require the token or an Origin of a read', async () => {
    const answer = await call('GET', 'read', { cookie: staff.cookie });

    expect(refused(answer)).toBe(false);
  });

  // Break caught (AC-SLICE-000-130): the CSRF slot after the permission slot, so that a caller who lacks the permission is told so
  // before the missing token; or authentication after CSRF, so that a caller with no session is told about the token.
  it('refuses for the CSRF check before the permission, and for the session before the CSRF check', async () => {
    const noToken = await call('POST', 'permission', { cookie: staff.cookie, origin: OPS });
    expect(noToken.body.code).toBe('CSRF_VALIDATION_FAILED');

    const noSession = await call('POST', 'write', { origin: 'https://evil.example' });
    expect(noSession.status).toBe(401);
    expect(noSession.body.code).toBe('SESSION_INVALID');
  });

  // Break caught (AC-SLICE-000-130): a malformed body decided before the CSRF slot, so that a cross-site caller learns that the
  // schema is wrong.
  it('refuses a cross-site request with a malformed body for the CSRF check and not for the body', async () => {
    const answer = await call('POST', 'ops-only', { origin: 'https://evil.example' }, '{ not json');

    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('CSRF_VALIDATION_FAILED');
  });
});

describe('the Rider: a bearer credential, with no Origin and no token (GBT-W7, GBT-W12)', () => {
  let riderToken: string;
  let browserStaff: StaffPersona;

  beforeAll(async () => {
    const issued = machinery.tokens.issue();
    riderToken = issued.token;
    await insertSessionRow(
      admin,
      sessionRow({
        principalType: 'RIDER',
        principalId: randomUUID(),
        registeredDeviceId: randomUUID(),
        policyRevision: 1,
        bundleId: BUNDLE_IDS.rider,
        snapshot: { format: 1, name: 'Rider', audience: 'RIDER', privileged: false, grants: [] },
        tokenHash: Buffer.from(issued.hash),
        csrfTokenHash: null,
      }),
    );
    browserStaff = await staffPersona(machinery, admin);
  });

  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${riderToken}` });

  // Break caught: the bearer path held to the browser rule, which would refuse the Rider app on every mutation.
  it('is not refused by the CSRF slot without an Origin or a token, and not for a hostile Origin it carries', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(refused(await call(method, 'write', bearer()))).toBe(false);
    }
    expect(
      refused(await call('POST', 'write', { ...bearer(), origin: 'https://evil.example' })),
    ).toBe(false);
    expect(refused(await call('POST', 'rider-only', bearer()))).toBe(false);
  });

  // Break caught: a browser session cookie accepted by a Rider-only operation, as a second credential for it.
  it('refuses a browser session cookie, with its token and Origin, on a Rider-only operation', async () => {
    const answer = await call('POST', 'rider-only', {
      cookie: browserStaff.cookie,
      origin: OPS,
      'x-csrf-token': browserStaff.issued.csrfToken ?? '',
    });

    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe('SESSION_INVALID');
    expect(handled).toBe(0);
  });

  it('refuses a bearer credential on a browser-only operation', async () => {
    const answer = await call('POST', 'browser-only', bearer());

    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe('SESSION_INVALID');
    expect(handled).toBe(0);
  });

  // Break caught: a cookie and a bearer credential together read as the bearer, which would let a browser request ride the
  // exclusion from the token: the ambiguity is refused whichever the route takes.
  it('refuses a cookie and a bearer credential together, on every route', async () => {
    for (const path of ['write', 'rider-only', 'browser-only']) {
      const answer = await call('POST', path, { ...bearer(), cookie: browserStaff.cookie });
      expect(answer.status).toBe(401);
    }
    expect(handled).toBe(0);
  });

  // Break caught: a Rider's bearer token presented as the cookie of a browser session, or the reverse.
  it('refuses the Rider’s token as a cookie, and a staff token as a bearer credential', async () => {
    expect((await call('POST', 'write', { cookie: `melarc_session=${riderToken}` })).status).toBe(
      401,
    );
    expect(
      (await call('POST', 'write', { authorization: `Bearer ${browserStaff.issued.token}` }))
        .status,
    ).toBe(401);
  });

  it('is not made a browser by anything it says about itself, nor a native client by a browser request', async () => {
    // A bearer request is the Rider's, whatever its User-Agent says.
    expect(
      refused(await call('POST', 'write', { ...bearer(), 'user-agent': 'Mozilla/5.0 Chrome/130' })),
    ).toBe(false);
    // A cookie request without the token is refused, whatever its User-Agent says.
    expect(
      refused(
        await call('POST', 'write', {
          cookie: browserStaff.cookie,
          origin: OPS,
          'user-agent': 'MelarcRider/1.0 okhttp/4.12',
        }),
      ),
    ).toBe(true);
  });
});

describe('what a vendor session may do', () => {
  // Break caught (GBT-W1, GBT-W2): a vendor session judged against the Ops origin, so that the Ops Portal's page could act as the
  // Vendor PWA (or the reverse).
  it('is held to the Vendor origin, and a staff session to the Ops origin', async () => {
    const issued = machinery.tokens.issue();
    const csrfToken = machinery.tokens.issue();
    await insertSessionRow(
      admin,
      sessionRow({
        principalType: 'VENDOR',
        principalId: randomUUID(),
        registeredDeviceId: randomUUID(),
        policyRevision: 1,
        bundleId: BUNDLE_IDS.vendor,
        snapshot: { format: 1, name: 'Vendor', audience: 'VENDOR', privileged: false, grants: [] },
        tokenHash: Buffer.from(issued.hash),
        csrfTokenHash: Buffer.from(csrfToken.hash),
      }),
    );
    const cookie = `melarc_session=${issued.token}; melarc_csrf=${csrfToken.token}`;
    const headers = { cookie, 'x-csrf-token': csrfToken.token };

    expect(refused(await call('POST', 'write', { ...headers, origin: VENDOR }))).toBe(false);
    expect(refused(await call('POST', 'write', { ...headers, origin: OPS }))).toBe(true);
  });
});
