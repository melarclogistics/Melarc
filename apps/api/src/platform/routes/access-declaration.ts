import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

import type { RateLimitBucket } from '../auth/ports/rate-limiter.port.js';
import type { IdentifierSpec } from '../http/admission/bounded-identifier.js';
import { DescribeSecurityByDefault } from '../openapi/operation-statements.js';

/** Metadata key under which a controller or route declares how it may be reached: one of the four kinds below. */
export const ACCESS_DECLARATION_KEY = 'melarc:access';

/** Metadata key under which a route keeps what its declaration adds to the kind: the permission it requires, the bucket it is limited in. */
export const ACCESS_DETAIL_KEY = 'melarc:access-detail';

/**
 * How a route may be reached (SOLUTION_ARCHITECTURE.md §6; permission-enforcement.md §5; `AC-SLICE-000-25`, `-43`). A route that
 * declares none is refused, never permitted by framework default. The four kinds, and what each is for:
 *
 * - `technical`: an operational endpoint, such as a probe. Reachable with no principal, not part of the product contract.
 * - `anonymous`: a pre-authentication operation of the contract (`security: []`, `x-permission: none`): sign-in, setup, recovery,
 *   enrolment. It may name the rate-limit bucket and the identifier it is keyed on.
 * - `self`: an operation on the caller's own record (`x-permission: self`) that any authenticated principal of a served
 *   surface may perform.
 * - `permission`: an operation that needs a key of the closed permission catalogue (`x-permission: <key>`).
 */
export type AccessDeclaration = 'technical' | 'anonymous' | 'self' | 'permission';

/**
 * The bucket an anonymous operation is limited in, and the identifier it is keyed on: taken from the body with a bounded
 * extraction before the body is validated (`boundedIdentifier`), and put into the canonical form the bucket's key uses by
 * `canonical` (lower-casing an email, reading a phone number in its canonical form belong to the credential rules, S0.3).
 * `canonical` returns `undefined` for text that is not an identifier, and the request then meets the coarse admission limits only.
 */
export interface AnonymousLimit {
  readonly bucket: RateLimitBucket;
  readonly identifier: IdentifierSpec;
  readonly canonical: (raw: string) => string | undefined;
}

export interface AccessDetail {
  /** The permission key of a `permission` declaration. */
  readonly permission?: string;
  /** The bucket of an `anonymous` declaration. */
  readonly limit?: AnonymousLimit;
}

/**
 * The shape of a key of the closed permission catalogue (permissions.md §7): two or three lower-case segments, joined by dots,
 * each beginning with a letter. `none` and `self` are words of the contract's `x-permission` and are not keys. Every key of the
 * seeded catalogue has this shape (`access-declaration.test.ts` reads them); whether a key is in the catalogue is the authorization
 * guard's to check against the database (S0.26), not this shape's.
 */
const PERMISSION_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

export function isPermissionKey(text: string): boolean {
  return PERMISSION_KEY.test(text);
}

/**
 * Marks an operational endpoint, such as a probe: reachable with no principal and not part of the product contract. Applying it to
 * a business route would hide that route from drift detection, so the set of technical routes is pinned by a test of the live
 * route inventory.
 */
export const TechnicalEndpoint = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'technical');

/**
 * Declares a pre-authentication operation. It also states it in the application's description: no credential is required
 * (`security: []`, unless the route states another with `DescribeSecurity`, as `vendorSignIn` does for the registered browser)
 * and the permission is `none`. With `limit` the route is limited in a bucket, keyed on an identifier of its body.
 */
export const Anonymous = (limit?: AnonymousLimit): MethodDecorator =>
  applyDecorators(
    SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'anonymous'),
    ...(limit === undefined
      ? []
      : [SetMetadata<string, AccessDetail>(ACCESS_DETAIL_KEY, { limit })]),
    DescribeSecurityByDefault(),
    ApiExtension('x-permission', 'none'),
  );

/** Declares an operation on the caller's own record: any authenticated principal of a served surface, no permission key. */
export const Self = (): MethodDecorator =>
  applyDecorators(
    SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'self'),
    ApiExtension('x-permission', 'self'),
  );

/**
 * Declares an operation that needs a key of the closed permission catalogue. The key is checked for its shape when the route is
 * declared, so a mistyped one stops the application at start and does not become a permission nobody holds.
 */
export const RequiresPermission = (key: string): MethodDecorator => {
  if (!isPermissionKey(key)) {
    throw new TypeError(
      `${JSON.stringify(key)} is not a permission key (two or three lower-case segments joined by dots)`,
    );
  }
  return applyDecorators(
    SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'permission'),
    SetMetadata<string, AccessDetail>(ACCESS_DETAIL_KEY, { permission: key }),
    ApiExtension('x-permission', key),
  );
};
