import { Module, type DynamicModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ContractValidationInterceptor } from './contract-validation.interceptor.js';
import { ContractValidationService } from './contract-validation.service.js';
import { CONTRACT_SOURCE, type ContractSource } from './contract-source.js';

/**
 * Validation of requests and responses against the contract, for every handler bound to an operation with
 * `@ContractOperation`. Global, so a product module needs only the decorator.
 */
@Module({})
export class ContractValidationModule {
  static register(options: { readonly source: ContractSource }): DynamicModule {
    return {
      module: ContractValidationModule,
      providers: [
        { provide: CONTRACT_SOURCE, useValue: options.source },
        ContractValidationService,
        { provide: APP_INTERCEPTOR, useClass: ContractValidationInterceptor },
      ],
    };
  }
}
