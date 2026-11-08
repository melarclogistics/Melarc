import { Module } from '@nestjs/common';

import { reasonDefinitionsProviders } from './reason-definitions-providers.js';
import { ReasonDefinitionsController } from './reason-definitions.controller.js';

/**
 * The `settings` permission domain (S0.35: the first key segment of `settings.reason.read`; no new domain). It holds the read of the
 * reason catalogue; the writing of it (`upsertReasonDefinition`) is SLICE-013's. It depends on the platform and nothing depends on it.
 */
@Module({
  controllers: [ReasonDefinitionsController],
  providers: [...reasonDefinitionsProviders],
})
export class SettingsModule {}
