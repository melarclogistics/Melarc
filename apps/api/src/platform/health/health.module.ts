import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { ReadinessRegistry } from './readiness.registry.js';

@Module({
  controllers: [HealthController],
  providers: [ReadinessRegistry],
  exports: [ReadinessRegistry],
})
export class HealthModule {}
