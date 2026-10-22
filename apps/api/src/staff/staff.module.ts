import { Module } from '@nestjs/common';

import { staffIdentitiesProviders } from './staff-identities-providers.js';
import { StaffIdentitiesController } from './staff-identities.controller.js';

/**
 * The `staff` permission domain (S0.35: the reads of staff identities; the first adapter this domain provided was the staff identity
 * directory of the authentication ports, which the composition root binds and which is not a Nest module). It depends on the platform
 * and nothing depends on it. The staff operations that change a record (create, approve, re-issue) are S0.36's.
 */
@Module({
  controllers: [StaffIdentitiesController],
  providers: [...staffIdentitiesProviders],
})
export class StaffModule {}
