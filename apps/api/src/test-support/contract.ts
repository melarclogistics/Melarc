import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

export interface Contract {
  readonly openapi: string;
  readonly components: {
    readonly schemas: {
      readonly Error: {
        readonly properties: { readonly code: { readonly enum: readonly string[] } };
      };
    };
  };
}

let cached: Contract | undefined;

/** The canonical contract, read from the repository. Tests compare against it; they never write it. */
export function loadContract(): Contract {
  cached ??= parse(
    readFileSync(resolve(import.meta.dirname, '../../../../contracts/openapi.yaml'), 'utf8'),
  ) as Contract;
  return cached;
}
