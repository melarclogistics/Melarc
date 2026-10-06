import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Logger } from 'pino';

import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { LOGGER } from '../platform.tokens.js';
import { TechnicalEndpoint } from '../routes/access-declaration.js';
import { ReadinessRegistry } from './readiness.registry.js';

type NotReadyReason = 'starting' | 'shutting_down' | 'dependency_unavailable';

type ReadinessBody = { status: 'ready' } | { status: 'not_ready'; reason: NotReadyReason };

/**
 * Operational probes for the platform that runs the API. Not part of the product contract and not
 * under /api/v1: the edge proxies only /api/... to the API runtime, so its routing does not expose
 * them. That is not isolation by itself: a caller that can reach the runtime directly can request them,
 * so the runtime must stay unreachable from browsers and the Internet (DEPLOYMENT_AND_ENVIRONMENTS.md
 * §12.5).
 *
 * Liveness means "the process answers", and stays healthy while draining so the platform does not
 * kill an instance that is finishing its work. Readiness means "send traffic here": it is false while
 * starting, while draining and while a registered dependency is failing. Bodies carry a coarse reason
 * only, never a dependency name or an error.
 */
@Controller()
@TechnicalEndpoint()
@ApiExcludeController()
export class HealthController {
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly readiness: ReadinessRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get('livez')
  @Header('Cache-Control', 'no-store')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessBody> {
    const reason = await this.notReadyReason();
    if (reason === undefined) return { status: 'ready' };
    response.status(503);
    return { status: 'not_ready', reason };
  }

  private async notReadyReason(): Promise<NotReadyReason | undefined> {
    if (this.lifecycle.state === 'starting') return 'starting';
    if (this.lifecycle.state === 'draining') return 'shutting_down';

    const failing = await this.readiness.failing();
    if (failing.length === 0) return undefined;
    this.logger.warn({ checks: failing }, 'readiness check failing');
    return 'dependency_unavailable';
  }
}
