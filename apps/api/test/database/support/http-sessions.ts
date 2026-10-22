import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import {
  TOKEN_SERVICE,
  type TokenService,
} from '../../../src/platform/auth/ports/token-service.port.js';
import type { RequestOptions, TestClient } from '../../../src/test-support/test-client.js';
import { BUNDLE_IDS, GRANTS } from '../../../src/tools/seed/bundles.js';
import { OPS_STAFF_SNAPSHOT, insertSessionRow, sessionRow, type SessionRow } from './identities.js';
import type { IntegrationKit } from './integration.js';

/**
 * A browser that presents a session credential it holds **by value**, as one that kept it would, with a jar of its own that holds
 * nothing to forget it with: every request carries the cookie (`melarc_session`, and `melarc_csrf` when the session has a
 * synchronizer token) and, for an unsafe request, that token in the header. The credential is a persona's issued token or a row
 * arranged with a token the application's own token service made.
 */
export function presenting(kit: IntegrationKit, token: string, csrf?: string): TestClient {
  const client = kit.client.fork();
  const original = client.request.bind(client);
  client.request = (method: string, path: string, options?: RequestOptions) =>
    original(method, path, {
      ...options,
      headers: {
        ...options?.headers,
        cookie: `melarc_session=${token}${csrf === undefined ? '' : `; melarc_csrf=${csrf}`}`,
      },
      ...(csrf === undefined ? {} : { csrf }),
    });
  return client;
}

/**
 * A Vendor's or a Rider's live session as a row, with the credentials a client would hold, for an application composed with the
 * fixed-policy revision and the organisation resolver their sign-ins (S0.48, S0.59) will give it (`startIntegrationKit` options).
 */
export async function arrangedFixedSession(
  kit: IntegrationKit,
  admin: Pick<pg.Client, 'query'>,
  type: 'VENDOR' | 'RIDER',
): Promise<{
  readonly row: SessionRow;
  readonly token: string;
  readonly csrf: string | undefined;
}> {
  const tokens = kit.app.app.get<TokenService>(TOKEN_SERVICE, { strict: false });
  const issued = tokens.issue();
  const csrf = type === 'VENDOR' ? tokens.issue() : undefined;
  const row = await insertSessionRow(
    admin,
    sessionRow({
      principalType: type,
      principalId: randomUUID(),
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: type === 'VENDOR' ? BUNDLE_IDS.vendor : BUNDLE_IDS.rider,
      // The snapshot holds what the seed grants the fixed bundle (a Vendor holds none of this slice's keys), as an issue would copy it.
      snapshot: {
        ...OPS_STAFF_SNAPSHOT,
        name: type === 'VENDOR' ? 'Vendor' : 'Rider',
        audience: type,
        grants: GRANTS.filter(
          (grant) => grant.bundleId === (type === 'VENDOR' ? BUNDLE_IDS.vendor : BUNDLE_IDS.rider),
        )
          .map((grant) => ({
            permission: grant.permissionKey,
            hubScope: grant.hubScope,
            ownershipScope: grant.ownershipScope,
            tier: grant.tier,
          }))
          .toSorted((a, b) => (a.permission < b.permission ? -1 : 1)),
      },
      tokenHash: Buffer.from(issued.hash),
      csrfTokenHash: csrf === undefined ? null : Buffer.from(csrf.hash),
    }),
  );
  return { row, token: issued.token, csrf: csrf?.token };
}
