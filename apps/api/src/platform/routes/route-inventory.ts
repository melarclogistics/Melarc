import 'reflect-metadata';

import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';

import { API_PREFIX, TECHNICAL_ROUTE_PATHS } from '../http/routes.constants.js';
import { ACCESS_DECLARATION_KEY, type AccessDeclaration } from './access-declaration.js';

export interface RouteEntry {
  readonly method: string;
  readonly path: string;
}

export interface DeclaredRoute extends RouteEntry {
  readonly access: AccessDeclaration | undefined;
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

      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;

        const access =
          (Reflect.getMetadata(ACCESS_DECLARATION_KEY, handler) as AccessDeclaration | undefined) ??
          classAccess;
        for (const controllerPath of controllerPaths) {
          for (const routePath of asPaths(Reflect.getMetadata(PATH_METADATA, handler))) {
            const relative = normalise(`${controllerPath}/${routePath}`);
            declared.push({
              method: RequestMethod[method],
              path: technical.has(relative) ? relative : normalise(`${API_PREFIX}/${relative}`),
              access,
            });
          }
        }
      }
    }
  }
  return declared.toSorted(byKey);
}

export function inspectRoutes(app: INestApplication): RouteInspection {
  const live = listLiveRoutes(app);
  const declared = listDeclaredRoutes(app);
  const liveKeys = new Set(live.map(key));
  const declaredKeys = new Set(declared.map(key));
  return {
    live,
    declared,
    undeclared: declared
      .filter((route) => route.access === undefined)
      .map(({ method, path }) => ({ method, path })),
    outsideNest: live.filter((route) => !declaredKeys.has(key(route))),
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
  const { undeclared, outsideNest, missingFromRouter } = inspectRoutes(app);
  const lines = [
    ...undeclared.map((route) => `declares no access: ${key(route)}`),
    ...outsideNest.map((route) => `registered outside Nest, so no guard runs: ${key(route)}`),
    ...missingFromRouter.map((route) => `declared but not served: ${key(route)}`),
  ];
  if (lines.length > 0) {
    throw new Error(
      `The route inventory is not sound:\n${lines.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}
