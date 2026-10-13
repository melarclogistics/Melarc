import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

import type { RateLimitBucket } from '../auth/ports/rate-limiter.port.js';
import { isTier, TIER_RULE_NAME, type Tier } from '../authorization/tier-policy.js';
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

/** The two browser surfaces, whose origins the deployment configures (`OPS_ORIGIN`, `VENDOR_ORIGIN`). */
export type BrowserSurface = 'OPS_PORTAL' | 'VENDOR_PWA';
export const BROWSER_SURFACES: readonly BrowserSurface[] = ['OPS_PORTAL', 'VENDOR_PWA'];

/**
 * The client an anonymous operation serves (S0.25; SECURITY_DESIGN.md §13.8, "Client policy"). The contract classifies each
 * operation by it, and the implementation states the same fact in code, so that a pre-session mutation is never held to a rule
 * for the wrong client, nor released from the right one by an omission:
 *
 * - `browser`: a pre-session credential mutation made by a page (staff and vendor sign-in, setup, recovery, enrolment). Served
 *   only with an `Origin` that exactly matches a configured origin of one of its `surfaces`; a missing, `null` or unlisted one is
 *   `403 CSRF_VALIDATION_FAILED`. It must name its surfaces, and a shared operation (recovery) names both.
 * - `native`: an operation of the Melarc Rider app (or a provider), which carries no `Origin` under its declared protocol and is
 *   never refused for the absence of one. It is never a browser bypass: it accepts no browser session cookie, and a `User-Agent` or
 *   a client-type string the caller supplies makes nothing native. The contract's operations that do not declare the origin
 *   refusal are exactly these.
 *
 * Left out, an anonymous operation is `browser` on both surfaces: the strict reading, so that forgetting to classify an operation
 * makes it harder to reach and not easier.
 */
export type AnonymousClient =
  | { readonly kind: 'browser'; readonly surfaces: readonly BrowserSurface[] }
  | { readonly kind: 'native' };

export const BROWSER_ON_BOTH_SURFACES: AnonymousClient = Object.freeze({
  kind: 'browser',
  surfaces: BROWSER_SURFACES,
});

/** The surfaces that can serve an authenticated operation: the Ops Portal's staff, the Vendor PWA's vendors, the Rider app's riders. */
export type ServedSurface = 'OPS_PORTAL' | 'VENDOR_PWA' | 'RIDER_ANDROID';
export const SERVED_SURFACES: readonly ServedSurface[] = [
  'OPS_PORTAL',
  'VENDOR_PWA',
  'RIDER_ANDROID',
];

/**
 * Whether a request on an authenticated route counts as the person acting, for the idle lifetime of a browser session (decision A of
 * 12 October 2026; SECURITY_DESIGN.md §13.3). It is stated by the route, on the server, and never by anything the client sends.
 *
 * - `qualifying`: the request is the person's own action. One that passes the guards (rate limit, authentication, CSRF,
 *   authorization) and is not itself a refusal of authority extends the idle lifetime, whatever the use case then answers: a
 *   validation or state-conflict answer to an authorized action is still activity.
 * - `background`: the request is made by the page on its own (a poll, a refresh, a keep-alive), so it never extends the idle
 *   lifetime. A session that only ever polls ends when its idle limit says so. The route is still authenticated and still refused
 *   once the session is idle.
 *
 * There is no default: a route states one, because a forgotten polling route that defaulted to `qualifying` would keep an unattended
 * session alive for ever, and one that defaulted to `background` would end a session under a person who is using it.
 */
export type ActivityPolicy = 'qualifying' | 'background';
export const ACTIVITY_POLICIES: readonly ActivityPolicy[] = ['qualifying', 'background'];

/**
 * An operation that names one record by a path parameter, and the entity it names (S0.26; permission-enforcement.md §5.1 step 7).
 * The authorization step finds out, before the body is validated, whether the caller can see the record: a miss is `NOT_FOUND`, and
 * for a staff member whose miss is a record that exists in another hub it is `HUB_SCOPE_VIOLATION` by the scope probe
 * (SECURITY_DESIGN.md §14.4b). The entity is a name in the registry of `record-scope.ts`, which a slice extends when it adds a
 * table; an unknown name stops the application at start.
 */
export interface RecordScope {
  readonly entity: string;
  /** The path parameter that carries the record's id. */
  readonly param: string;
}

/**
 * What the tier of the authorizing grant must be for the operation (permission-enforcement.md §5.1 step 6; `AC-SLICE-000-114`). Both
 * parts are decided in the authorization guard, after the key is found and before the record is looked for, the body validated or
 * anything written, so that a caller who holds the key and not the tier is refused `INSUFFICIENT_AUTHORITY` before they learn
 * anything of the operation's schema.
 */
export interface TierDeclaration {
  /** The least tier the grant must carry whatever the target is: decided before anything is looked up. */
  readonly minimum?: Tier;
  /**
   * The name of a rule in `TIER_RULES` that derives what the target needs from facts of its authoritative record. It needs the
   * `record` the route names, and it is asked only once that record is found visible to the caller (a caller who may not see a record
   * is answered by the scope and learns nothing of what the record needs).
   */
  readonly rule?: string;
}

/** What every authenticated route states beside what it requires (S0.26). */
export interface AuthenticatedRouteOptions {
  /** Who it serves, by surface. A principal of a surface not named here is refused `403 PERMISSION_DENIED` (the surface gate). */
  readonly surfaces: readonly ServedSurface[];
  readonly activity: ActivityPolicy;
  /** The record the route names, if it names one. */
  readonly record?: RecordScope;
  /** The tier the operation needs, if it needs one beyond holding the key. Not for a `self` operation, which has no grant. */
  readonly tier?: TierDeclaration;
}

export interface AccessDetail {
  /** The permission key of a `permission` declaration. */
  readonly permission?: string;
  /** The bucket of an `anonymous` declaration. */
  readonly limit?: AnonymousLimit;
  /** The client of an `anonymous` declaration (S0.25). */
  readonly client?: AnonymousClient;
  /** What a `self` or `permission` declaration states beside it (S0.26). */
  readonly authenticated?: AuthenticatedRouteOptions;
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
 * and the permission is `none`. With `limit` the route is limited in a bucket, keyed on an identifier of its body. With `client`
 * it states who calls it (S0.25): a browser page, which the `Origin` check holds to the allowlist of its surfaces, or the native
 * Rider app, which carries no `Origin`. Without it the route is a browser route on both surfaces.
 */
export const Anonymous = (
  limit?: AnonymousLimit,
  client: AnonymousClient = BROWSER_ON_BOTH_SURFACES,
): MethodDecorator => {
  if (client.kind === 'browser') {
    const surfaces: readonly unknown[] = client.surfaces;
    if (
      surfaces.length === 0 ||
      !surfaces.every((surface) => BROWSER_SURFACES.includes(surface as BrowserSurface)) ||
      new Set(surfaces).size !== surfaces.length
    ) {
      throw new TypeError(
        'A browser operation names the surfaces it serves, each once: the Ops Portal, the Vendor PWA, or both',
      );
    }
  } else if ((client as { kind: unknown }).kind !== 'native') {
    throw new TypeError('An anonymous operation is for a browser page or for the native client');
  }
  return applyDecorators(
    SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'anonymous'),
    SetMetadata<string, AccessDetail>(ACCESS_DETAIL_KEY, {
      ...(limit === undefined ? {} : { limit }),
      client,
    }),
    DescribeSecurityByDefault(),
    ApiExtension('x-permission', 'none'),
  );
};

function checkedOptions(options: AuthenticatedRouteOptions): AuthenticatedRouteOptions {
  const given = options as unknown as Record<string, unknown>;
  const surfaces: unknown = given.surfaces;
  if (
    !Array.isArray(surfaces) ||
    surfaces.length === 0 ||
    !surfaces.every((surface) => SERVED_SURFACES.includes(surface as ServedSurface)) ||
    new Set(surfaces).size !== surfaces.length
  ) {
    throw new TypeError(
      'An authenticated operation names the surfaces it serves, each once: the Ops Portal, the Vendor PWA, the Rider app',
    );
  }
  if (!ACTIVITY_POLICIES.includes(given.activity as ActivityPolicy)) {
    throw new TypeError(
      'An authenticated operation states whether a request of it counts as the person acting: qualifying or background',
    );
  }
  const tier: unknown = given.tier;
  if (tier !== undefined) {
    const refused = new TypeError(
      'A tier declaration names a minimum tier (A, S or P), a rule, or both',
    );
    if (typeof tier !== 'object' || tier === null) throw refused;
    const named = tier as Record<string, unknown>;
    const hasMinimum = named.minimum !== undefined;
    const hasRule = named.rule !== undefined;
    if (
      (!hasMinimum && !hasRule) ||
      (hasMinimum && !isTier(named.minimum)) ||
      (hasRule && (typeof named.rule !== 'string' || !TIER_RULE_NAME.test(named.rule)))
    ) {
      throw refused;
    }
    if (hasRule && given.record === undefined) {
      throw new TypeError('A tier rule derives what a record needs, so the route names the record');
    }
  }
  const record: unknown = given.record;
  if (record !== undefined) {
    const named = record as Record<string, unknown>;
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof named.entity !== 'string' ||
      !/^[a-z][a-z0-9_]*$/.test(named.entity) ||
      typeof named.param !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9]*$/.test(named.param)
    ) {
      throw new TypeError(
        'A record scope names an entity and the path parameter that carries its id',
      );
    }
  }
  return Object.freeze({
    surfaces: Object.freeze([...(surfaces as ServedSurface[])]),
    activity: given.activity as ActivityPolicy,
    ...(record === undefined ? {} : { record: Object.freeze({ ...(record as RecordScope) }) }),
    ...(tier === undefined ? {} : { tier: Object.freeze({ ...(tier as TierDeclaration) }) }),
  });
}

/**
 * Declares an operation on the caller's own record: any authenticated principal of a surface it serves, no permission key. It
 * states, as every authenticated operation does, the surfaces it serves and whether a request of it counts as activity.
 */
export const Self = (options: AuthenticatedRouteOptions): MethodDecorator => {
  const authenticated = checkedOptions(options);
  if (authenticated.tier !== undefined) {
    throw new TypeError('A self operation holds no grant, so it has no tier to declare');
  }
  return applyDecorators(
    SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'self'),
    SetMetadata<string, AccessDetail>(ACCESS_DETAIL_KEY, { authenticated }),
    ApiExtension('x-permission', 'self'),
  );
};

/**
 * Declares an operation that needs a key of the closed permission catalogue. The key is checked for its shape when the route is
 * declared, so a mistyped one stops the application at start and does not become a permission nobody holds. It states the
 * surfaces it serves and its activity policy, as `Self` does, and the record it names if it names one.
 */
export const RequiresPermission = (
  key: string,
  options: AuthenticatedRouteOptions,
): MethodDecorator => {
  if (!isPermissionKey(key)) {
    throw new TypeError(
      `${JSON.stringify(key)} is not a permission key (two or three lower-case segments joined by dots)`,
    );
  }
  const authenticated = checkedOptions(options);
  return applyDecorators(
    SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'permission'),
    SetMetadata<string, AccessDetail>(ACCESS_DETAIL_KEY, { permission: key, authenticated }),
    ApiExtension('x-permission', key),
  );
};
