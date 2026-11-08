import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { VendorPickupLocationsService } from './vendor-pickup-locations.service.js';

/** The injection token of the service of the saved-location read (S1.14), which its controller asks for. */
export const VENDOR_PICKUP_LOCATIONS_SERVICE = Symbol('VENDOR_PICKUP_LOCATIONS_SERVICE');

/** The service, built on the operation runner the platform provides, and `undefined` where it is missing (the read then fails closed, `503`). */
export const vendorPickupLocationsProviders: readonly FactoryProvider[] = [
  {
    provide: VENDOR_PICKUP_LOCATIONS_SERVICE,
    useFactory: (runner: OperationRunner | undefined): VendorPickupLocationsService | undefined =>
      runner === undefined ? undefined : new VendorPickupLocationsService({ runner }),
    inject: [{ token: OPERATION_RUNNER, optional: true }],
  },
];
