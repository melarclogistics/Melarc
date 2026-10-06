import type { BoundOperation } from '../../platform/contract/contract-operation.js';
import type { RouteEntry } from '../../platform/routes/route-inventory.js';
import { compareOperations } from './compare-operations.js';
import type { Finding } from './findings.js';
import { isJsonObject, type Json, type JsonObject } from '../../platform/contract/json.js';
import { describeOperation, findOperation, listOperations } from './operation-description.js';
import { createModel } from './schema-normalizer.js';

export interface ConformanceInput {
  /** The canonical contract, parsed. The authority. */
  readonly contract: JsonObject;
  /** The description derived from the running application's own controllers. */
  readonly generated: JsonObject;
  /** What the HTTP router answers, read from the router itself and not from the description. */
  readonly live: readonly RouteEntry[];
  /**
   * The operation ids the implementation claims, stated explicitly. Until the whole API exists only this
   * intentional scope is compared (engineering-standards.md section 4), so it has to be what is true: a
   * live operation that is not listed is a finding, and so is a listed one that is not live.
   */
  readonly scope: readonly string[];
  /** Routes that are answered but are not part of the product contract, such as the probes. */
  readonly technicalRoutes: readonly RouteEntry[];
  /** The handlers bound to a contract operation with `@ContractOperation`, which the runtime validates. */
  readonly bound: readonly BoundOperation[];
}

export interface ConformanceReport {
  readonly findings: Finding[];
  /** The operations whose descriptions were compared with the contract's, sorted. */
  readonly checkedOperations: string[];
}

/**
 * A route reduced to its shape: the same for the router's `/things/:id` and the contract's `/things/{id}`,
 * and whatever the parameter is called. Names are compared as part of the operation; the shape alone decides
 * whether two routes are the same route.
 */
export function routeShape(path: string): string {
  const segments = path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => (segment.startsWith(':') || /^\{[^}]+\}$/.test(segment) ? ':' : segment));
  return `/${segments.join('/')}`;
}

function serverPrefix(document: JsonObject): string {
  const first = Array.isArray(document.servers)
    ? (document.servers as readonly Json[])[0]
    : undefined;
  const url = isJsonObject(first) && typeof first.url === 'string' ? first.url : '';
  return url.replace(/\/$/, '');
}

const routeKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${routeShape(path)}`;

/**
 * Compares the implementation with the contract: which routes exist, whether each is declared and
 * described, and, for every operation in scope, whether its description says what the contract says. It
 * reads the router for what is live, so a route cannot hide by being left out of the description.
 */
export function checkConformance(input: ConformanceInput): ConformanceReport {
  const findings: Finding[] = [];
  const checked: string[] = [];

  const contractPrefix = serverPrefix(input.contract);
  const generatedPrefix = serverPrefix(input.generated);
  const contractOperations = listOperations(input.contract);
  const contractById = new Map(
    contractOperations.flatMap((operation) =>
      operation.id === undefined ? [] : [[operation.id, operation] as const],
    ),
  );
  const contractByRoute = new Map(
    contractOperations.flatMap((operation) =>
      operation.id === undefined
        ? []
        : [[routeKey(operation.method, contractPrefix + operation.path), operation.id] as const],
    ),
  );

  const boundRoutes = new Map(
    input.bound.map((entry) => [routeKey(entry.method, entry.path), entry.operationId] as const),
  );
  const scope = new Set(input.scope);
  const technical = new Set(
    input.technicalRoutes.map((route) => routeKey(route.method, route.path)),
  );
  const live = new Set(input.live.map((route) => routeKey(route.method, route.path)));

  for (const route of input.live) {
    if (technical.has(routeKey(route.method, route.path))) continue;
    const at = `${route.method} ${route.path}`;
    const operationId = contractByRoute.get(routeKey(route.method, route.path));
    if (operationId === undefined) {
      findings.push({
        code: 'UNDOCUMENTED_ROUTE',
        at,
        message:
          'The router answers this route, it is not a technical probe, and the contract has no operation at it.',
      });
    } else if (!scope.has(operationId)) {
      findings.push({
        code: 'ROUTE_OUTSIDE_SCOPE',
        at,
        message: `This route serves the operation ${operationId}, which the implemented scope does not list.`,
      });
    }
  }

  const contractModel = createModel(input.contract);
  const generatedModel = createModel(input.generated);
  const reportedNotLive = new Set<string>();

  for (const operationId of [...scope].toSorted()) {
    const operation = contractById.get(operationId);
    if (operation === undefined) {
      findings.push({
        code: 'SCOPE_OPERATION_UNKNOWN',
        at: `scope > ${operationId}`,
        message: `The implemented scope lists ${operationId}, and the contract has no such operation.`,
      });
      continue;
    }
    const at = `${operation.method} ${operation.path}`;
    const key = routeKey(operation.method, contractPrefix + operation.path);

    if (!live.has(key)) {
      reportedNotLive.add(key);
      findings.push({
        code: 'OPERATION_NOT_LIVE',
        at,
        message: `${operationId} is in the implemented scope and the router does not answer ${at}.`,
      });
    }

    if (live.has(key) && boundRoutes.get(key) !== operationId) {
      findings.push({
        code: 'OPERATION_NOT_VALIDATED',
        at,
        message: `${operationId} is implemented and its handler is not bound to it, so nothing validates its requests against the contract. Bind it with @ContractOperation('${operationId}').`,
      });
    }

    const described = findOperation(input.generated, operationId);
    if (described === undefined) {
      findings.push({
        code: 'OPERATION_NOT_DESCRIBED',
        at,
        message: `${operationId} is in the implemented scope and the application's own description does not contain it.`,
      });
      continue;
    }

    checked.push(operationId);
    findings.push(
      ...compareOperations(
        describeOperation(contractModel, input.contract, operation.path, operation.method),
        describeOperation(generatedModel, input.generated, described.path, described.method),
      ),
    );
  }

  for (const described of listOperations(input.generated)) {
    const key = routeKey(described.method, generatedPrefix + described.path);
    if (live.has(key) || reportedNotLive.has(key)) continue;
    findings.push({
      code: 'DESCRIBED_BUT_NOT_LIVE',
      at: `${described.method} ${generatedPrefix}${described.path.replace(/\{([^}]+)\}/g, ':$1')}`,
      message: 'The description documents this route and the router does not answer it.',
    });
  }

  return { findings, checkedOperations: checked.toSorted() };
}
