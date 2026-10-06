import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

import type { AppConfig } from '../config/load-config.js';
import { APP_CONFIG } from '../platform.tokens.js';
import { listBoundOperations } from './contract-operation.js';
import { CONTRACT_SOURCE, type ContractSource } from './contract-source.js';
import { ContractValidator } from './contract-validator.js';

/**
 * Owns the contract validator of this application. The contract is read the first time something needs it,
 * which is at start only if a handler is bound to an operation, so an application with none (today's) never
 * pays for reading it.
 */
@Injectable()
export class ContractValidationService implements OnApplicationBootstrap {
  private instance: ContractValidator | undefined;

  constructor(
    @Inject(CONTRACT_SOURCE) private readonly source: ContractSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly modules: ModulesContainer,
  ) {}

  /** Responses are checked outside production only: a check on every answer is for finding defects, not for serving. */
  get validatesResponses(): boolean {
    return this.config.nodeEnv !== 'production';
  }

  validator(): ContractValidator {
    this.instance ??= new ContractValidator(this.source.load());
    return this.instance;
  }

  /**
   * Refuses to start an application that binds a handler to an operation the contract does not have, or whose
   * schemas cannot be compiled: either would leave a route unvalidated without a sound.
   */
  onApplicationBootstrap(): void {
    const bound = listBoundOperations(this.modules);
    if (bound.length === 0) return;

    const validator = this.validator();
    const unknown = bound.filter(({ operationId }) => !validator.hasOperation(operationId));
    if (unknown.length > 0) {
      throw new Error(
        `Handlers are bound to operations that are not in the contract:\n${unknown
          .map((entry) => `  ${entry.operationId} (${entry.method} ${entry.path})`)
          .join('\n')}`,
      );
    }
    const taking = bound.filter((entry) => entry.bypass !== undefined);
    if (taking.length > 0) {
      throw new Error(
        'Handlers bound to an operation must leave the response to the framework, or nothing can validate ' +
          `what they send:\n${taking
            .map(
              (entry) =>
                `  ${entry.operationId} (${entry.method} ${entry.path}): ${entry.bypass ?? ''}`,
            )
            .join('\n')}`,
      );
    }
    for (const { operationId } of bound) validator.prepare(operationId);
  }
}
