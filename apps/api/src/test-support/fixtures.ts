import { Body, Controller, Get, Inject, Module, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';

import { LOGGER } from '../platform/platform.tokens.js';
import { TechnicalEndpoint } from '../platform/routes/access-declaration.js';

/**
 * Routes that exist only in tests. They are never part of the production module graph, so they can
 * exercise real request handling (route templates, concurrency, failures) without adding a route to
 * the product.
 *
 * They borrow the technical access declaration because the permission declaration arrives with the
 * first product slice; what the tests need from it is only "declared".
 */
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
