import { sql } from 'drizzle-orm';

/**
 * The statement fragment that erases a job's payload: the ciphertext and its envelope go, and the time they went is kept. Shared by
 * the issuing side (a cancellation) and the worker side (every outcome that ends the job), so the two cannot disagree about what an
 * erased payload looks like; the table's `payload_follows_state` constraint refuses any other shape.
 */
export const ERASE_PAYLOAD = sql`payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
    payload_envelope_version = null, payload_erased_at = clock_timestamp()`;
