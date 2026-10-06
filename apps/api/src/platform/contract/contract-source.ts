import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { isJsonObject, type JsonObject } from './json.js';
import { locateContract } from './locate-contract.js';

const requireModule = createRequire(import.meta.url);

/** Injection token for the place the runtime gets contracts/openapi.yaml from. */
export const CONTRACT_SOURCE = Symbol('CONTRACT_SOURCE');

/** Where the runtime gets contracts/openapi.yaml from. Read on first use, never at import or at start. */
export interface ContractSource {
  load(): JsonObject;
}

/**
 * The contract file of the repository this code runs in. A deployment has to ship it beside the application:
 * the runtime refuses to start when an operation is bound and the file is not there.
 */
export const fileContractSource: ContractSource = {
  load(): JsonObject {
    const path = locateContract(import.meta.dirname);
    // Loaded here, not at import: reading the contract is rare, and the parser is not free to load.
    const { parse } = requireModule('yaml') as typeof import('yaml');
    const document: unknown = parse(readFileSync(path, 'utf8'));
    if (!isJsonObject(document) || typeof document.openapi !== 'string') {
      throw new Error(`${path} is not an OpenAPI document.`);
    }
    return document;
  },
};
