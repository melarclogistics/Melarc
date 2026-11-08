import type { FactoryProvider } from '@nestjs/common';
import type { Logger } from 'pino';

import { LOGGER } from '../../platform.tokens.js';
import {
  ATTESTATION_VERIFIER,
  type AttestationVerifier,
} from '../ports/attestation-verifier.port.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { SESSION_STORE, type SessionStore } from '../ports/session-store.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { SETUP_GRANT_STORE } from '../setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../setup-grants/setup-grant-store.js';
import { RiderDeviceStore } from './rider-device-store.js';
import { RiderEnrolmentService } from './rider-enrolment.service.js';

/** The injection tokens of the rider's registered devices and of the service of their enrolment (S0.57). */
export const RIDER_DEVICE_STORE = Symbol('RIDER_DEVICE_STORE');
export const RIDER_ENROLMENT_SERVICE = Symbol('RIDER_ENROLMENT_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store of the rider's devices, built on the clock, and the enrolment service, built from the ports the composition root bound; each is
 * `undefined` where one is missing (an application without a database, without local key material for the pepper that hashes a PIN, or without a
 * verifier), and the operation fails closed (`503`). Nothing falls back to a stand-in that pretends to have registered a device.
 */
export const riderEnrolmentProviders: readonly FactoryProvider[] = [
  {
    provide: RIDER_DEVICE_STORE,
    useFactory: (clock: Clock | undefined): RiderDeviceStore | undefined =>
      clock === undefined ? undefined : new RiderDeviceStore({ clock }),
    inject: [optional(CLOCK)],
  },
  {
    provide: RIDER_ENROLMENT_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      grants: SetupGrantStore | undefined,
      devices: RiderDeviceStore | undefined,
      sessions: SessionStore | undefined,
      verifier: AttestationVerifier | undefined,
      tokens: TokenService | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      audit: AuditWriter | undefined,
      logger: Logger,
    ): RiderEnrolmentService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      grants === undefined ||
      devices === undefined ||
      sessions === undefined ||
      verifier === undefined ||
      tokens === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      audit === undefined
        ? undefined
        : new RiderEnrolmentService({
            unitOfWork,
            directory,
            grants,
            devices,
            sessions,
            verifier,
            tokens,
            hasher,
            hashAdmission,
            audit,
            // The closed cause, and nothing the evidence carried: the response says only that the device could not be checked.
            onUnavailable: (cause) => {
              logger.warn(
                {
                  event: 'attestation_unavailable',
                  operation: 'completeRiderDeviceEnrolment',
                  cause,
                },
                'The attestation evidence could not be evaluated now',
              );
            },
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(SETUP_GRANT_STORE),
      optional(RIDER_DEVICE_STORE),
      optional(SESSION_STORE),
      optional(ATTESTATION_VERIFIER),
      optional(TOKEN_SERVICE),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(AUDIT_WRITER),
      LOGGER,
    ],
  },
];
