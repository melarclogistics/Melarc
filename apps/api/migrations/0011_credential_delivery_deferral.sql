-- G2-03: a worker that cannot open a payload, or confirm a redemption record, has not sent anything, and the claim that found it out
-- is not one of the sends the schedule allows. Forward-only: it adds to migration 0009's table and replaces its guard function.
--
--   * credential_delivery_job.deferred_claims counts the claims that ended with a recorded deferral. The sends so far are
--     attempt_count - deferred_claims (a CHECK keeps it between nought and attempt_count). A claim whose worker says nothing (a crash)
--     is not counted there, so it still counts as an attempt.
--   * The outcome class PAYLOAD_DEFERRED joins the closed set and the classes a RETRYABLE job may carry.
--   * The guard lets deferred_claims rise by exactly one, only when a leased job becomes RETRYABLE with PAYLOAD_DEFERRED or
--     REDEMPTION_UNCONFIRMED, never otherwise (nor fall); and it refuses those two outcomes without that rise.
--   * The worker's capability role may UPDATE that one column; the API runtime may not.

ALTER TABLE "credential_delivery_job" DROP CONSTRAINT "credential_delivery_job_outcome_class_closed";--> statement-breakpoint
ALTER TABLE "credential_delivery_job" DROP CONSTRAINT "credential_delivery_job_outcome_follows_state";--> statement-breakpoint
ALTER TABLE "credential_delivery_job" ADD COLUMN "deferred_claims" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_delivery_job" ADD CONSTRAINT "credential_delivery_job_deferrals_bounded" CHECK ("credential_delivery_job"."deferred_claims" >= 0 AND "credential_delivery_job"."deferred_claims" <= "credential_delivery_job"."attempt_count");--> statement-breakpoint
ALTER TABLE "credential_delivery_job" ADD CONSTRAINT "credential_delivery_job_outcome_class_closed" CHECK ("credential_delivery_job"."outcome_class" IS NULL OR "credential_delivery_job"."outcome_class" IN ('ACCEPTED', 'UNKNOWN', 'REJECTED', 'DESTINATION_NOT_ALLOWED', 'SCHEDULE_EXHAUSTED', 'PAYLOAD_UNREADABLE', 'PAYLOAD_DEFERRED', 'EXPIRED', 'CANCELLED', 'RELINQUISHED', 'REDEMPTION_UNCONFIRMED'));--> statement-breakpoint
ALTER TABLE "credential_delivery_job" ADD CONSTRAINT "credential_delivery_job_outcome_follows_state" CHECK (("credential_delivery_job"."state" = 'QUEUED' AND "credential_delivery_job"."outcome_class" IS NULL)
        OR ("credential_delivery_job"."state" = 'LEASED')
        OR ("credential_delivery_job"."state" = 'RETRYABLE' AND "credential_delivery_job"."outcome_class" IN ('UNKNOWN', 'RELINQUISHED', 'REDEMPTION_UNCONFIRMED', 'PAYLOAD_DEFERRED'))
        OR ("credential_delivery_job"."state" = 'ACCEPTED' AND "credential_delivery_job"."outcome_class" = 'ACCEPTED')
        OR ("credential_delivery_job"."state" = 'FAILED' AND "credential_delivery_job"."outcome_class" IN ('REJECTED', 'DESTINATION_NOT_ALLOWED', 'SCHEDULE_EXHAUSTED', 'PAYLOAD_UNREADABLE'))
        OR ("credential_delivery_job"."state" = 'EXPIRED' AND "credential_delivery_job"."outcome_class" = 'EXPIRED')
        OR ("credential_delivery_job"."state" = 'CANCELLED' AND "credential_delivery_job"."outcome_class" = 'CANCELLED'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION melarc.credential_delivery_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moment timestamptz := clock_timestamp();
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.redemption_record_type IS DISTINCT FROM OLD.redemption_record_type
     OR NEW.redemption_record_id IS DISTINCT FROM OLD.redemption_record_id
     OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.provider_dedupe_id IS DISTINCT FROM OLD.provider_dedupe_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a delivery job keeps its identity, its record, its principal, its channel, its expiry and its deduplication identity' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a delivery job that has ended does not change' USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'LEASED' THEN
    -- A claim: the first lease of a job that is due, or the takeover of one whose lease ended with no outcome.
    IF OLD.state = 'LEASED' AND OLD.lease_expires_at > moment THEN
      RAISE EXCEPTION 'a delivery job whose lease has not ended is not claimed again' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> 'LEASED' AND OLD.next_attempt_at > moment THEN
      RAISE EXCEPTION 'a delivery job is claimed when it is due' USING ERRCODE = '23514';
    END IF;
    IF OLD.expires_at <= moment THEN
      RAISE EXCEPTION 'a delivery job is not leased past the end of its redemption record' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.lease_version <> OLD.lease_version + 1 THEN
      RAISE EXCEPTION 'a claim counts one attempt and raises the lease version by one' USING ERRCODE = '23514';
    END IF;
    IF NEW.lease_expires_at <= moment THEN
      RAISE EXCEPTION 'a lease ends in the future' USING ERRCODE = '23514';
    END IF;
    -- The most a claim may ask for is the application's (MAX_LEASE_MS): a lease that ran for years would strand its job.
    IF NEW.lease_expires_at > moment + interval '1 hour' THEN
      RAISE EXCEPTION 'a lease is at most an hour' USING ERRCODE = '23514';
    END IF;
    IF NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
       OR NEW.payload_nonce IS DISTINCT FROM OLD.payload_nonce
       OR NEW.payload_key_version IS DISTINCT FROM OLD.payload_key_version
       OR NEW.payload_envelope_version IS DISTINCT FROM OLD.payload_envelope_version THEN
      RAISE EXCEPTION 'a claim does not touch the payload' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.state = 'LEASED' AND NEW.state IN ('ACCEPTED', 'RETRYABLE', 'FAILED') THEN
    -- An outcome: the lease and the count stay as they were, which is what the writer's fence compared.
    IF NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_version <> OLD.lease_version
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
      RAISE EXCEPTION 'an outcome does not touch the lease owner, the lease version or the count of attempts' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'EXPIRED' THEN
    IF OLD.expires_at > moment THEN
      RAISE EXCEPTION 'a delivery job expires when its redemption record has ended' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state = 'CANCELLED' THEN
    -- The operation that consumed, superseded or invalidated the redemption record cancels (the authentication capability). The
    -- delivery worker ends a job it holds the lease of, when it finds the record closed, and no other: its policy admits any live
    -- job, so this is where a worker is kept from cancelling the queue.
    IF melarc.task_capability() = 'credential_delivery' AND OLD.state <> 'LEASED' THEN
      RAISE EXCEPTION 'the delivery worker ends only a job it holds the lease of' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'that change of state is not one a delivery job makes' USING ERRCODE = '23514';
  END IF;

  -- A payload is erased and never replaced, by whatever transition: the sealed fields only change to nothing.
  IF (NEW.payload_ciphertext IS NOT NULL AND NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext)
     OR (NEW.payload_nonce IS NOT NULL AND NEW.payload_nonce IS DISTINCT FROM OLD.payload_nonce)
     OR (NEW.payload_key_version IS NOT NULL AND NEW.payload_key_version IS DISTINCT FROM OLD.payload_key_version)
     OR (NEW.payload_envelope_version IS NOT NULL AND NEW.payload_envelope_version IS DISTINCT FROM OLD.payload_envelope_version) THEN
    RAISE EXCEPTION 'a payload is erased and never replaced' USING ERRCODE = '23514';
  END IF;

  -- A claim is given back only by recording that it ended before any provider was asked (a deferral), one claim at a time, by the
  -- worker that holds the lease. It is not given back by a claim, a cancellation, an expiry or any other outcome: a claim whose worker
  -- says nothing is an attempt that may have sent, and stays one. And a deferral always gives its claim back: a leased job that
  -- becomes RETRYABLE with a deferral class without the count rising would spend a send on a claim that sent nothing.
  IF NEW.deferred_claims IS DISTINCT FROM OLD.deferred_claims
     OR (OLD.state = 'LEASED' AND NEW.state = 'RETRYABLE' AND NEW.outcome_class IN ('PAYLOAD_DEFERRED', 'REDEMPTION_UNCONFIRMED')) THEN
    IF NOT (OLD.state = 'LEASED' AND NEW.state = 'RETRYABLE' AND NEW.deferred_claims = OLD.deferred_claims + 1
            AND NEW.outcome_class IN ('PAYLOAD_DEFERRED', 'REDEMPTION_UNCONFIRMED')) THEN
      RAISE EXCEPTION 'a claim is given back only by recording a deferral, and a deferral gives back its claim, one at a time' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
GRANT UPDATE ("deferred_claims") ON "credential_delivery_job" TO melarc_worker_cap_credential_delivery;
