import 'reflect-metadata';

import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';

import { API_PREFIX, TECHNICAL_ROUTE_PATHS } from '../http/routes.constants.js';
import { RECORD_ENTITIES_TOKEN, type RecordEntities } from '../authorization/record-scope.js';
import { TIER_RULES_TOKEN, type TierRules } from '../authorization/tier-policy.js';
import { credentialModesOf, type CredentialMode } from '../openapi/operation-statements.js';
import type { RateLimitBucket } from '../auth/ports/rate-limiter.port.js';
import {
  ACCESS_DECLARATION_KEY,
  ACCESS_DETAIL_KEY,
  type AccessDeclaration,
  type AccessDetail,
  type AnonymousClient,
  type AuthenticatedRouteOptions,
  type ServedSurface,
} from './access-declaration.js';

export interface RouteEntry {
  readonly method: string;
  readonly path: string;
}

export interface DeclaredRoute extends RouteEntry {
  readonly access: AccessDeclaration | undefined;
  /** The permission key of a `permission` route. */
  readonly permission?: string;
  /** The bucket of an `anonymous` route that is limited. */
  readonly bucket?: RateLimitBucket;
  /** Who an `anonymous` route serves: a browser page (and which surfaces) or the native client (S0.25). */
  readonly client?: AnonymousClient;
  /** What a `self` or `permission` route states: the surfaces it serves, its activity policy and the record it names (S0.26). */
  readonly authenticated?: AuthenticatedRouteOptions;
  /** The credential modes the route takes, from the statement the description makes of it (S0.25). */
  readonly credentialModes?: ReadonlySet<CredentialMode>;
}

export interface RouteInspection {
  /** What the HTTP router will answer, read from the router itself. */
  readonly live: readonly RouteEntry[];
  /** What the controllers' decorators declare, read from Nest's metadata. */
  readonly declared: readonly DeclaredRoute[];
  /** Declared by a controller but with no access declaration: refused at runtime, and a defect. */
  readonly undeclared: readonly RouteEntry[];
  /** Answered by the router but declared by no controller: registered outside Nest, so no guard runs. */
  readonly outsideNest: readonly RouteEntry[];
  /** Routes whose declaration contradicts itself: a surface its credential modes cannot reach, or a record entity nobody knows. */
  readonly incoherent: readonly { readonly route: RouteEntry; readonly reason: string }[];
  /** Declared by a controller but not answered by the router. */
  readonly missingFromRouter: readonly RouteEntry[];
}

interface ExpressLayer {
  readonly route?: { readonly path: unknown; readonly methods: Record<string, boolean> };
  readonly handle?: { readonly stack?: readonly ExpressLayer[] };
}

const key = (route: RouteEntry) => `${route.method} ${route.path}`;
const byKey = (a: RouteEntry, b: RouteEntry) => key(a).localeCompare(key(b));

function normalise(path: string): string {
  const collapsed = `/${path}`.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/**
 * Nest's own fallthrough: an `_all` route on `*path` inside a sub-router, which answers every unknown
 * path with the framework's NotFound. It is not a route of this application.
 */
function isFrameworkFallthrough(layer: ExpressLayer): boolean {
  return layer.route?.path === '*path' && layer.route.methods._all === true;
}

function routesOfLayer(layer: ExpressLayer, mounted: boolean): RouteEntry[] {
  if (layer.route) {
    if (mounted && isFrameworkFallthrough(layer)) return [];
    const path = typeof layer.route.path === 'string' ? layer.route.path : String(layer.route.path);
    return Object.keys(layer.route.methods).map((method) => ({
      method: method === '_all' ? 'ALL' : method.toUpperCase(),
      // A router mounted by hand has a mount path that cannot be read back, so it is marked as such
      // and can never equal a declared route.
      path: mounted ? `(mounted router) ${path}` : path,
    }));
  }
  return (layer.handle?.stack ?? []).flatMap((nested) => routesOfLayer(nested, true));
}

/** The routes the HTTP server will actually answer, read from its router, independent of Nest's metadata. */
export function listLiveRoutes(app: INestApplication): RouteEntry[] {
  const express = app.getHttpAdapter().getInstance() as {
    router: { stack: readonly ExpressLayer[] };
  };
  return express.router.stack.flatMap((layer) => routesOfLayer(layer, false)).toSorted(byKey);
}

function asPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : '/'];
}

/** The routes the controllers' decorators declare, with their access declaration. */
export function listDeclaredRoutes(app: INestApplication): DeclaredRoute[] {
  const technical = new Set(TECHNICAL_ROUTE_PATHS.map((path) => normalise(path)));
  const declared: DeclaredRoute[] = [];

  for (const moduleRef of app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;

      const controllerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, controller));
      const classAccess = Reflect.getMetadata(ACCESS_DECLARATION_KEY, controller) as
        AccessDeclaration | undefined;
      const classDetail = Reflect.getMetadata(ACCESS_DETAIL_KEY, controller) as
        AccessDetail | undefined;

      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;

        const access =
          (Reflect.getMetadata(ACCESS_DECLARATION_KEY, handler) as AccessDeclaration | undefined) ??
          classAccess;
        const detail =
          (Reflect.getMetadata(ACCESS_DETAIL_KEY, handler) as AccessDetail | undefined) ??
          classDetail;
        for (const controllerPath of controllerPaths) {
          for (const routePath of asPaths(Reflect.getMetadata(PATH_METADATA, handler))) {
            const relative = normalise(`${controllerPath}/${routePath}`);
            declared.push({
              method: RequestMethod[method],
              path: technical.has(relative) ? relative : normalise(`${API_PREFIX}/${relative}`),
              access,
              ...(detail?.permission === undefined ? {} : { permission: detail.permission }),
              ...(detail?.limit === undefined ? {} : { bucket: detail.limit.bucket }),
              ...(access !== 'anonymous' || detail?.client === undefined
                ? {}
                : { client: detail.client }),
              ...(detail?.authenticated === undefined
                ? {}
                : {
                    authenticated: detail.authenticated,
                    credentialModes: credentialModesOf(handler),
                  }),
            });
          }
        }
      }
    }
  }
  return declared.toSorted(byKey);
}

/** The surface a credential mode can authenticate: a cookie is a browser session (staff or vendor), a bearer credential a Rider's. */
const SURFACES_OF_MODE: Readonly<Record<CredentialMode, readonly ServedSurface[]>> = {
  COOKIE: ['OPS_PORTAL', 'VENDOR_PWA'],
  BEARER: ['RIDER_ANDROID'],
};

function incoherentRoutes(
  declared: readonly DeclaredRoute[],
  entities: RecordEntities,
  tierRules: TierRules,
): { route: RouteEntry; reason: string }[] {
  const found: { route: RouteEntry; reason: string }[] = [];
  for (const route of declared) {
    const { authenticated, credentialModes } = route;
    if (authenticated === undefined || credentialModes === undefined) continue;
    const reachable = new Set([...credentialModes].flatMap((mode) => SURFACES_OF_MODE[mode]));
    for (const surface of authenticated.surfaces) {
      if (!reachable.has(surface)) {
        found.push({
          route: { method: route.method, path: route.path },
          reason: `serves ${surface}, which no credential the route takes can authenticate`,
        });
      }
    }
    if (
      authenticated.record !== undefined &&
      !Object.hasOwn(entities, authenticated.record.entity)
    ) {
      found.push({
        route: { method: route.method, path: route.path },
        reason: `names the record entity ${authenticated.record.entity}, which is not one of the application's`,
      });
    }
    if (
      authenticated.tier?.rule !== undefined &&
      !Object.hasOwn(tierRules, authenticated.tier.rule)
    ) {
      found.push({
        route: { method: route.method, path: route.path },
        reason: `names the tier rule ${authenticated.tier.rule}, which is not one of the application's`,
      });
    }
  }
  return found;
}

export function inspectRoutes(app: INestApplication): RouteInspection {
  const live = listLiveRoutes(app);
  const declared = listDeclaredRoutes(app);
  const entities =
    app.get<RecordEntities | undefined>(RECORD_ENTITIES_TOKEN, { strict: false }) ?? {};
  const tierRules = app.get<TierRules | undefined>(TIER_RULES_TOKEN, { strict: false }) ?? {};
  const liveKeys = new Set(live.map(key));
  const declaredKeys = new Set(declared.map(key));
  return {
    live,
    declared,
    undeclared: declared
      .filter((route) => route.access === undefined)
      .map(({ method, path }) => ({ method, path })),
    outsideNest: live.filter((route) => !declaredKeys.has(key(route))),
    incoherent: incoherentRoutes(declared, entities, tierRules),
    missingFromRouter: declared
      .filter((route) => !liveKeys.has(key(route)))
      .map(({ method, path }) => ({ method, path })),
  };
}

/**
 * Refuses to start an API whose routes are not all declared by a controller that states how they may
 * be reached (SOLUTION_ARCHITECTURE.md §6). Run it once the application has been initialised.
 */
export function assertRoutesAreSound(app: INestApplication): void {
  const { undeclared, outsideNest, missingFromRouter, incoherent } = inspectRoutes(app);
  const lines = [
    ...undeclared.map((route) => `declares no access: ${key(route)}`),
    ...incoherent.map(({ route, reason }) => `${key(route)} ${reason}`),
    ...outsideNest.map((route) => `registered outside Nest, so no guard runs: ${key(route)}`),
    ...missingFromRouter.map((route) => `declared but not served: ${key(route)}`),
  ];
  if (lines.length > 0) {
    throw new Error(
      `The route inventory is not sound:\n${lines.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}
