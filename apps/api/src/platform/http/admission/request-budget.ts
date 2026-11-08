import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';

import type { Clock } from '../../auth/ports/clock.port.js';
import { ExecutionBudget, runWithBudget } from '../../execution/execution-budget.js';
import { OPERATIONAL_FAILURE, writeFailure } from '../all-exceptions.filter.js';
import { PIPELINE_ANSWER_KEY } from './response-keys.js';

export interface RequestBudgetOptions {
  /** The clock the application was given, so that the budget, the database layer under it and the tests agree on time. */
  readonly clock: Clock;
  /** `REQUEST_EXECUTION_BUDGET_MS`: the longest one request may run once it has been admitted and its body received. */
  readonly budgetMs: number;
  /**
   * How long after the budget ran out the pipeline waits for the work, or for the database layer settling a transaction on its
   * behalf, to answer before it answers itself. The database layer promises its caller an answer within `DISPOSAL_BOUND_MS`
   * of an expiry (a commit in flight is told at once, as unknown; the rest is a cancel and a rollback bounded by it), so the
   * pipeline gives it that time: answering earlier could tell a client "unavailable" about a commit that has since turned out
   * to have happened.
   */
  readonly graceMs: number;
  /** The probes, which answer within their own deadlines and are never made to live inside a request's budget. */
  readonly isExempt: (request: Request) => boolean;
  /** Where the pipeline says that it answered. Optional so that the mechanism can be tested without a logger. */
  readonly logger?: Logger;
}

/**
 * The request's execution budget in the HTTP pipeline (S0.20; plan §11.8; OB-37). It is made once a request has been admitted
 * and its body has been received (transport admission and the body parser run before it), so that neither a wait at the gate nor
 * a slow sender spends it: the budget bounds what the application does with a request it has, which is what the receipt limits
 * do not. Everything the request starts runs under it (`runWithBudget`), so the database layer takes it as the parent of every
 * transaction and cancels, rolls back and refuses when it expires, and an outbound call made under `budget.effect(...)` is
 * refused or recorded late.
 *
 * **It is enforced and not raced.** Expiry is an event the work is wired to: the work fails with the budget's error and is
 * answered as every operational failure is (a `503`), or with an unknown commit outcome and is answered as that (a `500` of its
 * own). The pipeline does not answer in the budget's place. The one case it answers for is work that heeds nothing the
 * mechanism reaches (a wait on something other than the database, with no `effect`): after `graceMs` past the expiry, if the
 * response has not been sent, it is sent here as the outage it is. The work is not stopped by that and is not claimed to be;
 * whatever it goes on to do under the budget is refused, and an effect it had started is recorded as late.
 *
 * The budget is finished when the response is over, however it ended (sent, or the client left), so a finished budget never
 * fires, a timer is never left running and a continuation that kept the budget can start nothing for a request that is over.
 */
export function createRequestBudget(options: RequestBudgetOptions): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (options.isExempt(request)) {
      next();
      return;
    }
    const budget = new ExecutionBudget(options.clock, 'request', options.budgetMs);
    let fallback: NodeJS.Timeout | undefined;
    budget.onExpiry((error) => {
      fallback = setTimeout(() => {
        fallback = undefined;
        if (response.headersSent || response.writableEnded) return;
        options.logger?.warn(
          { label: error.label, budgetMilliseconds: error.budgetMilliseconds },
          'request answered by the pipeline: its work outlasted the budget',
        );
        response.locals[PIPELINE_ANSWER_KEY] = true;
        writeFailure(response, OPERATIONAL_FAILURE);
      }, options.graceMs);
      fallback.unref();
    });
    response.once('close', () => {
      if (fallback !== undefined) clearTimeout(fallback);
      fallback = undefined;
      budget.finish();
    });
    runWithBudget(budget, next);
  };
}
