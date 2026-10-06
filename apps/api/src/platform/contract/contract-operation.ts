import 'reflect-metadata';

import { applyDecorators, RequestMethod, SetMetadata } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  REDIRECT_METADATA,
  RENDER_METADATA,
  RESPONSE_PASSTHROUGH_METADATA,
  ROUTE_ARGS_METADATA,
  SSE_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { ApiOperation } from '@nestjs/swagger';

import { API_PREFIX } from '../http/routes.constants.js';

/** Metadata key under which a handler declares which operation of the contract it implements. */
export const CONTRACT_OPERATION_KEY = 'melarc:contract-operation';

/**
 * Binds a handler to an operation of contracts/openapi.yaml by its `operationId`. Two things follow from it:
 * the application's own description names the operation, so the conformance check can compare it, and every
 * request to the handler is validated against the contract's schemas, and every response outside production.
 *
 * A route that implements a contract operation and is not bound is reported by the conformance check, so
 * the validation cannot be left off by omission.
 */
export const ContractOperation = (operationId: string): MethodDecorator =>
  applyDecorators(
    SetMetadata<string, string>(CONTRACT_OPERATION_KEY, operationId),
    ApiOperation({ operationId }),
  );

export interface BoundOperation {
  readonly operationId: string;
  readonly method: string;
  /** As the router sees it: the API prefix included, parameters written `:name`. */
  readonly path: string;
  /**
   * Set when the handler takes the response out of the framework's hands (`@Res()` without passthrough,
   * `@Next()`, `@Sse()`, `@Redirect()`, `@Render()`): what it sends never passes through the interceptor, so a
   * binding to it would validate nothing. The text names the construct.
   */
  readonly bypass?: string;
}

/**
 * How a handler takes the answer over, if it does. `@Res({ passthrough: true })` does not: the framework still
 * sends the return value, and the handler only sets the status, headers and cookies, which the validator reads
 * from the response after the handler has run.
 */
function responseBypass(controller: object, name: string, handler: object): string | undefined {
  if (Reflect.hasMetadata(SSE_METADATA, handler)) return '@Sse()';
  if (Reflect.hasMetadata(REDIRECT_METADATA, handler)) return '@Redirect()';
  if (Reflect.hasMetadata(RENDER_METADATA, handler)) return '@Render()';

  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
    string,
    unknown
  >;
  const types = Object.keys(args).map((key) => Number(key.split(':')[0]));
  if (types.includes(RouteParamtypes.NEXT)) return '@Next()';
  const passthrough = Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, controller, name) === true;
  if (types.includes(RouteParamtypes.RESPONSE) && !passthrough) {
    return '@Res() without { passthrough: true }';
  }
  return undefined;
}

function normalise(path: string): string {
  const collapsed = `/${path}`.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

function asPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : '/'];
}

/**
 * Every handler bound to a contract operation, read from the controllers' metadata. The business routes
 * all live under the API prefix; the technical probes are never bound.
 */
export function listBoundOperations(modules: ModulesContainer): BoundOperation[] {
  const bound: BoundOperation[] = [];
  for (const moduleRef of modules.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const controllerPaths = asPaths(Reflect.getMetadata(PATH_METADATA, controller));

      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const operationId = Reflect.getMetadata(CONTRACT_OPERATION_KEY, handler) as
          string | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (operationId === undefined || method === undefined) continue;

        const bypass = responseBypass(controller, name, handler);
        for (const controllerPath of controllerPaths) {
          for (const routePath of asPaths(Reflect.getMetadata(PATH_METADATA, handler))) {
            bound.push({
              operationId,
              method: RequestMethod[method],
              path: normalise(`${API_PREFIX}/${controllerPath}/${routePath}`),
              ...(bypass === undefined ? {} : { bypass }),
            });
          }
        }
      }
    }
  }
  return bound.toSorted((a, b) =>
    `${a.operationId}${a.method}`.localeCompare(`${b.operationId}${b.method}`),
  );
}
