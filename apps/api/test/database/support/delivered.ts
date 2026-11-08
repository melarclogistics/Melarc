import type pg from 'pg';

import { AesGcmSecretCipher } from '../../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { KEY_PURPOSES, keyEnvName } from '../../../src/platform/config/key-material.js';
import { loadConfig } from '../../../src/platform/config/load-config.js';
import {
  decodeDeliveryPayload,
  deliveryPayloadContext,
} from '../../../src/platform/delivery/delivery-payload.js';
import type { DeliveryKind } from '../../../src/platform/delivery/delivery-vocabulary.js';
import { validEnv } from '../../../src/test-support/config-env.js';

/**
 * What a queued credential message holds, opened the way the delivery worker opens it, for a test that must hold the token the person
 * would be sent (the application returns it to nobody). The job's payload is sealed to its row, so this is the one honest way to ask
 * "what would the employee have received": read the job as the administrator and open the envelope with the key material the
 * application was configured with. The test makes one set of key material (`deliveryKeyEnv`), gives the application its entries as the
 * kit's `env`, and opens messages with the reader built from the same set. It is test support and works on a disposable database.
 */
export interface DeliveredMessage {
  readonly jobId: string;
  readonly destination: string;
  readonly link: string;
  /** The token in the link's fragment, as the setup page would read it. */
  readonly token: string;
  /** A vendor message's account identifier, which the message carries beside the link (S0.47); absent from every other message. */
  readonly accountIdentifier?: string;
}

interface JobRow {
  readonly id: string;
  readonly kind: DeliveryKind;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly redemption_record_type: 'SETUP_GRANT' | 'RECOVERY_REQUEST';
  readonly redemption_record_id: string;
  readonly payload_ciphertext: Buffer | null;
  readonly payload_nonce: Buffer | null;
  readonly payload_key_version: number | null;
  readonly payload_envelope_version: number | null;
}

/** A complete set of key material, and the entries of it the application is started with (never its database, which the kit sets). */
export function deliveryKeyEnv(): {
  readonly env: Record<string, string>;
  readonly keysOnly: Record<string, string>;
} {
  const env = validEnv();
  const keysOnly = Object.fromEntries(
    KEY_PURPOSES.flatMap((purpose) =>
      (['MATERIAL', 'ACTIVE_VERSION'] as const).map((part) => {
        const name = keyEnvName(purpose, part);
        return [name, env[name] ?? ''] as const;
      }),
    ),
  );
  return { env, keysOnly };
}

export type DeliveredReader = (
  admin: Pick<pg.Client, 'query'>,
  grantId: string,
) => Promise<DeliveredMessage | undefined>;

/** The reader of the messages queued for grants, built on the key material the application was given. */
export function deliveredReader(env: Readonly<Record<string, string>>): DeliveredReader {
  const loaded = loadConfig(env);
  if (!loaded.ok) throw new Error('the test configuration was refused');
  const cipher = new AesGcmSecretCipher(loaded.config.keys, { serves: ['DELIVERY_PAYLOAD'] });

  return async (admin, grantId) => {
    const result = await admin.query<JobRow>(
      `select id, kind, principal_type, principal_id, redemption_record_type, redemption_record_id, payload_ciphertext, payload_nonce,
              payload_key_version, payload_envelope_version
         from credential_delivery_job where redemption_record_id = $1 order by created_at desc limit 1`,
      [grantId],
    );
    const job = result.rows[0];
    if (
      job?.payload_ciphertext == null ||
      job.payload_nonce == null ||
      job.payload_key_version == null ||
      job.payload_envelope_version == null
    ) {
      return undefined;
    }
    const opened = await cipher.open(
      'DELIVERY_PAYLOAD',
      {
        envelopeVersion: job.payload_envelope_version,
        keyVersion: job.payload_key_version,
        nonce: new Uint8Array(job.payload_nonce),
        ciphertext: new Uint8Array(job.payload_ciphertext),
      },
      deliveryPayloadContext({
        jobId: job.id,
        kind: job.kind,
        principal: { type: job.principal_type, id: job.principal_id },
        redemption: { type: job.redemption_record_type, id: job.redemption_record_id },
      }),
    );
    const content = decodeDeliveryPayload(opened);
    const token = new URLSearchParams(new URL(content.link).hash.slice(1)).get('token');
    if (token === null) throw new Error('the delivered link carries no token');
    return {
      jobId: job.id,
      destination: content.destination,
      link: content.link,
      token,
      ...(content.accountIdentifier === undefined
        ? {}
        : { accountIdentifier: content.accountIdentifier }),
    };
  };
}
