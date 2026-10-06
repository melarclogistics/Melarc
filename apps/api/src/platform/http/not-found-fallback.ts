import { Inject, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express, Request, Response } from 'express';
import type { Logger } from 'pino';

import { LOGGER } from '../platform.tokens.js';
import { sendFailure } from './all-exceptions.filter.js';

/**
 * Answers a request that no route answers, wherever it points. Nest answers an unknown path under the API prefix
 * with the contract's error envelope, but it mounts that only under the prefix: a path outside it, and a method a
 * route does not take, reached Express's default handler, whose page echoes the method and path, carries no
 * request id and says which framework this is.
 *
 * It is added when the application has finished registering its routes (Nest runs this hook after the routes and
 * its own not-found and exception handlers), because Express answers by the order layers were added: added any
 * earlier it would answer first, and no route would be reached.
 */
@Injectable()
export class NotFoundFallback implements OnApplicationBootstrap {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter.getInstance<Express>();
    server.use((_request: Request, response: Response) => {
      sendFailure(response, new NotFoundException(), this.logger);
    });
  }
}
