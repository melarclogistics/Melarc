import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  type CanActivate,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';

import {
  AcquireTimeoutError,
  PoolClosedError,
  PoolSaturatedError,
} from '../platform/database/connection-queue.js';
import {
  CommitOutcomeUnknownError,
  DatabaseDeadlineError,
  TransactionRolledBackError,
} from '../platform/database/database-failures.js';
import {
  BudgetExpiredError,
  currentBudget,
  type ExecutionBudget,
} from '../platform/execution/execution-budget.js';
import { LOGGER } from '../platform/platform.tokens.js';
import { TechnicalEndpoint } from '../platform/routes/access-declaration.js';

/** The budgets the fixture routes saw, so a test can look at a budget after the response that carried it has been sent. */
export const observedBudgets: ExecutionBudget[] = [];

/** Refuses every request the way an authentication guard does, so a test can see what runs before a guard and what after. */
class FixtureRefusalGuard implements CanActivate {
  canActivate(): boolean {
    throw new HttpException('refused by the fixture guard', 401);
  }
}

/**
 * Routes that exist only in tests. They are never part of the production module graph, so they can
 * exercise real request handling (route templates, concurrency, failures) without adding a route to
 * the product.
 *
 * They borrow the technical access declaration because the permission declaration arrives with the
 * first product slice; what the tests need from it is only "declared".
 */
function seen(): { present: boolean; label?: string; remainingMs?: number; closed?: boolean } {
  const budget = currentBudget();
  if (budget === undefined) return { present: false };
  observedBudgets.push(budget);
  return {
    present: true,
    label: budget.label,
    remainingMs: Math.round(budget.remainingMilliseconds()),
    closed: budget.closed,
  };
}

@Controller('fixture')
@TechnicalEndpoint()
export class FixtureController {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  @Get('orders/:id')
  order(): { found: boolean } {
    return { found: true };
  }

  /** Fails the way real faults do: with the request and credentials riding along on the error. */
  @Get('throw-secret')
  throwSecret(): never {
    const error = new Error(
      'connect failed postgres://melarc:hunter2@db.internal/melarc token=abc123',
    );
    Object.assign(error, {
      request: {
        headers: { authorization: 'Bearer HEADER-SECRET' },
        body: { password: 'BODY-SECRET' },
      },
    });
    throw error;
  }

  /** Sends its answer itself and then fails, so the failure arrives after the response has left. */
  @Get('fails-after-answering')
  failsAfterAnswering(@Res({ passthrough: true }) response: Response): void {
    response.status(200).json({ answered: true });
    throw new Error('failed after the answer was sent');
  }

  @Get('slow/:label')
  async slow(@Param('label') label: string, @Query('ms') ms: string): Promise<{ label: string }> {
    await new Promise((resolve) => setTimeout(resolve, Number(ms)));
    this.logger.info({ label }, 'fixture handler finished');
    return { label };
  }

  /** Reads a request body and logs from inside the handler, as every business operation that takes one will. */
  @Post('body/:label')
  async withBody(
    @Param('label') label: string,
    @Body() body: unknown,
  ): Promise<{ label: string; received: unknown }> {
    await Promise.resolve();
    this.logger.info({ label }, 'fixture handler finished');
    return { label, received: body };
  }

  /** A route behind a guard that always refuses: whatever the body is, the guard answers first and the handler is never reached. */
  @Post('guarded')
  @UseGuards(FixtureRefusalGuard)
  guarded(): never {
    this.logger.info({ label: 'guarded' }, 'fixture handler finished');
    throw new Error('the guard let a request through');
  }

  /** What the application believes about the caller's connection, which depends on the trusted-proxy setting. */
  @Get('whoami')
  whoami(@Req() request: Request): { ip: string | undefined; protocol: string; hostname: string } {
    return { ip: request.ip, protocol: request.protocol, hostname: request.hostname };
  }

  /** What a handler sees of its request budget, and whether it is still open when the handler answers. */
  @Get('budget')
  budget(): { present: boolean; label?: string; remainingMs?: number; closed?: boolean } {
    return seen();
  }

  /** The same for a request that has a body, which the budget must not have been waiting for. */
  @Post('budget')
  budgetWithBody(@Body() body: unknown): {
    present: boolean;
    label?: string;
    remainingMs?: number;
    closed?: boolean;
    received: unknown;
  } {
    return { ...seen(), received: body };
  }

  /** Looks at the budget after a pause, so a test can move the clock it was given in the meantime. */
  @Get('budget-after-pause')
  async afterPause(@Query('ms') ms: string): Promise<{ expired: boolean | undefined }> {
    await new Promise((resolve) => setTimeout(resolve, Number(ms)));
    return { expired: currentBudget()?.expired };
  }

  /** Records its budget and then keeps working past the client, which may have gone away: the budget is not the handler's to finish. */
  @Get('budget-then-wait')
  async thenWait(@Query('ms') ms: string): Promise<{ waited: number }> {
    seen();
    await new Promise((resolve) => setTimeout(resolve, Number(ms)));
    return { waited: Number(ms) };
  }

  /** Waits for the budget to run out and fails the way work does when it is told: by its error. A handler that heeds its budget. */
  @Get('cooperative')
  async cooperative(): Promise<never> {
    const budget = currentBudget();
    if (budget === undefined) throw new Error('this route needs a request budget');
    return new Promise<never>((_resolve, reject) => {
      budget.onExpiry(reject);
    });
  }

  /** Fails with one of the typed failures of the platform's own resources, directly or beneath a wrapper as drizzle leaves them. */
  @Get('fail/:kind')
  fail(@Param('kind') kind: string): never {
    const cause = { cause: new Error('driver said: postgres://melarc:hunter2@db.internal/melarc') };
    const failures: Readonly<Record<string, () => Error>> = {
      budget: () => new BudgetExpiredError('request', 15_000),
      deadline: () => new DatabaseDeadlineError('statement', '57014', cause),
      saturated: () => new PoolSaturatedError(64),
      acquire: () => new AcquireTimeoutError(3_000),
      closed: () => new PoolClosedError(),
      wrapped: () =>
        new Error('Failed query: select 1', {
          cause: new DatabaseDeadlineError('lock', '55P03', cause),
        }),
      unknown: () => new CommitOutcomeUnknownError('connection-lost', cause),
      'rolled-back': () => new TransactionRolledBackError(cause),
    };
    const make = failures[kind];
    throw make === undefined ? new Error(`no such failure: ${kind}`) : make();
  }
}

/** A controller where only one of two routes carries a declaration. */
@Controller('fixture-partial')
export class PartialFixtureController {
  @Get('declared')
  @TechnicalEndpoint()
  declared(): { ok: boolean } {
    return { ok: true };
  }

  @Get('undeclared')
  undeclared(): { ok: boolean } {
    return { ok: true };
  }
}

/** A controller that declares nothing at all: the shape of a route added carelessly. */
@Controller('fixture-undeclared')
export class UndeclaredFixtureController {
  @Get('ping')
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [FixtureController] })
export class FixtureModule {}

@Module({ controllers: [PartialFixtureController, UndeclaredFixtureController] })
export class AccessFixtureModule {}
