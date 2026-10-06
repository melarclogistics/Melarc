import { SetMetadata } from '@nestjs/common';

/** Metadata key under which a controller or route declares how it may be reached. */
export const ACCESS_DECLARATION_KEY = 'melarc:access';

/**
 * The declarations that exist today. The permission declaration arrives with the first product slice
 * (SLICE-000), beside this one; until then a route can only be technical or refused.
 */
export type AccessDeclaration = 'technical';

/**
 * Marks an operational endpoint, such as a probe: reachable with no principal and not part of the
 * product contract. Applying it to a business route would hide that route from drift detection, so
 * the set of technical routes is pinned by a test of the live route inventory.
 */
export const TechnicalEndpoint = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AccessDeclaration>(ACCESS_DECLARATION_KEY, 'technical');
