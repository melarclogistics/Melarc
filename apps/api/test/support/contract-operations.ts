import { readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { isJsonObject, type JsonObject } from '../../src/platform/contract/json.js';
import { locateContract } from '../../src/platform/contract/locate-contract.js';
import { IMPLEMENTED_OPERATIONS } from '../../src/tools/contract/implemented-scope.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

export interface ContractOperation {
  readonly id: string;
  /** The HTTP method in capitals. */
  readonly method: string;
  /** The path as the contract writes it, `{id}` and all, without the `/api/v1` prefix of the servers. */
  readonly path: string;
}

/**
 * The operations of contracts/openapi.yaml in the order the contract states them. The process tests ask what the real commands made of the
 * application and compare it with the contract and the implemented scope as they are, instead of with a list typed in the test, which
 * every operation implemented would otherwise make untrue (the lists of S0.60 were: 42 operations, and the contract holds 192).
 */
export function contractOperations(): readonly ContractOperation[] {
  const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
  const paths = contract.paths;
  if (!isJsonObject(paths)) throw new Error('The contract has no paths');
  const operations: ContractOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isJsonObject(operation)) continue;
      const id = operation.operationId;
      if (typeof id !== 'string')
        throw new Error(`${method.toUpperCase()} ${path} has no operationId`);
      operations.push({ id, method: method.toUpperCase(), path });
    }
  }
  return operations;
}

/** The operations of the implemented scope, as the contract describes them. */
export function implementedOperations(): readonly ContractOperation[] {
  const all = contractOperations();
  const implemented = all.filter((operation) => IMPLEMENTED_OPERATIONS.includes(operation.id));
  if (implemented.length !== IMPLEMENTED_OPERATIONS.length) {
    throw new Error('The implemented scope names an operation the contract does not have');
  }
  return implemented;
}

/** The first operation of the contract that the implemented scope does not list: it stops only when the whole product is implemented. */
export function firstOperationOutsideTheScope(): ContractOperation {
  const found = contractOperations().find(
    (operation) => !IMPLEMENTED_OPERATIONS.includes(operation.id),
  );
  if (found === undefined) {
    throw new Error(
      'Every operation of the contract is implemented: a test needs another way to name one that is not',
    );
  }
  return found;
}
