import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';

import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { bodyBytesOf } from '../http/json-body.js';
import { answerPrincipalOf } from './answer-context.js';
import { CONTRACT_OPERATION_KEY } from './contract-operation.js';
import { ContractValidationService } from './contract-validation.service.js';
import type { ContractViolation } from './contract-validator.js';

/**
 * A response that does not say what the contract says. Its message names the operation and where the
 * response is wrong, never what it contained, and it reaches the client only as a plain server error.
 */
export class ContractViolationError extends Error {
  override name = 'ContractViolationError';

  constructor(
    readonly operationId: string,
    readonly violations: readonly ContractViolation[],
  ) {
    super(
      `The response of ${operationId} does not conform to the contract: ${violations
        .map((violation) => `${violation.in} ${violation.pointer || '(whole)'} ${violation.rule}`)
        .join('; ')}`,
    );
  }
}

/**
 * Whether the request carried a body at all. What the body parser counted is the answer when it read one: it hands
 * over `{}` for an empty JSON body, which is not a body, and a chunked request has no length to say so. The headers
 * decide only for a request that was not read as JSON.
 */
function hasBody(request: Request): boolean {
  const read = bodyBytesOf(request);
  if (read !== undefined) return read > 0;
  const length = Number(request.headers['content-length'] ?? 0);
  return length > 0 || request.headers['transfer-encoding'] !== undefined;
}

/**
 * Validates every request to a handler bound to a contract operation, before the handler runs, and every
 * response outside production. It runs after the guards, so a caller who may not use the operation learns
 * nothing about its schema. Handlers that are not bound are not touched.
 */
@Injectable()
export class ContractValidationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: ContractValidationService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const operationId = this.reflector.get<string | undefined>(
      CONTRACT_OPERATION_KEY,
      context.getHandler(),
    );
    if (operationId === undefined) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const validator = this.service.validator();

    const violations = validator.validateRequest(operationId, {
      params: request.params,
      query: request.query,
      headers: request.headers,
      body: request.body as unknown,
      hasBody: hasBody(request),
    });
    if (violations.length > 0) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations,
      });
    }

    if (!this.service.validatesResponses) return next.handle();
    return next.handle().pipe(
      map((body: unknown) => {
        // The framework sets the status before the handler runs (`@HttpCode`, else 201 for a POST and 200 for
        // the rest), the handler may change it with `@Res({ passthrough: true })`, and nothing sets it again
        // when the answer is sent. So the status on the response now is the status that goes out.
        //
        // An answer a handler already sent is out of reach: its body cannot be read, only reported. (A bound
        // handler cannot take the response over with a decorator; this is one that reached it another way.)
        if (response.headersSent) {
          throw new ContractViolationError(operationId, [
            { in: 'status', pointer: String(response.statusCode), rule: 'sent-by-handler' },
          ]);
        }
        const answeredFor = answerPrincipalOf(request);
        const problems = validator.validateResponse(
          operationId,
          { status: response.statusCode, body, headers: response.getHeaders() },
          // What the caller presented decides which cookies the answer owes (x-set-cookies-for), and so does
          // whose answer it is, which only the handler knows (x-set-cookies-when).
          request,
          answeredFor === undefined ? undefined : { principalType: answeredFor },
        );
        if (problems.length > 0) throw new ContractViolationError(operationId, problems);
        return body;
      }),
    );
  }
}
