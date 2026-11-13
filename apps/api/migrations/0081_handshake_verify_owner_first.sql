-- melarc.handshake_verify as 0070 made it, locking only a stop of the caller (OB-S1-74 (2); Run A, 12 November 2026). The function took the stop's row lock before it knew the stop was
-- the caller's, so another vendor (or another rider) that had guessed a stop's identifier could tell, by how long the refusal took, that someone was working on it, although the
-- answer was the same. The request (a vendor's pickup) or the run (a rider's assignment) is now joined in the locking select, as 0073 did for melarc.dispute_collection: a stop
-- that is not the caller's is refused without a lock having been asked for on it. Nothing else changes: the same locks are taken in the same order (the stop, then its
-- handshake), so the order the other acts meet (the stop first, then the manifest or the handshake) is the order they met before, and the owner, the grant and the revocation
-- of 0070 are stated again with the replacement.
CREATE OR REPLACE FUNCTION melarc.handshake_verify(p_stop uuid, p_digests bytea[])
RETURNS TABLE (out_outcome text, out_handshake_id uuid, out_state text, out_direction text, out_channel text, out_attempts integer, out_remaining integer,
               out_expires_at timestamp with time zone, out_fallback_sends integer, out_authorised_by uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  kind text := melarc.principal_type();
  rider uuid := melarc.current_rider_id();
  vendor uuid := melarc.current_vendor_organization_id();
  stop_row public.pickup_stop%ROWTYPE;
  record_row public.collection_record%ROWTYPE;
  h public.collection_handshake%ROWTYPE;
  manifest_state text;
  assigned uuid;
  moment timestamp with time zone;
  max_attempts integer;
  before_state text;
  chosen_channel text;
  outcome text;
BEGIN
  IF kind NOT IN ('RIDER', 'VENDOR') OR coalesce(pg_catalog.current_setting('melarc.authorization_key', true), '') <> 'pickup.collection.confirm' THEN
    RAISE EXCEPTION 'a code is entered by the rider of the stop or by the vendor whose pickup it is' USING ERRCODE = '42501';
  END IF;
  IF p_stop IS NULL OR p_digests IS NULL OR pg_catalog.cardinality(p_digests) < 1 OR pg_catalog.cardinality(p_digests) > 8 THEN
    RAISE EXCEPTION 'a code is checked with one to eight digests' USING ERRCODE = '22023';
  END IF;
  -- Ownership is judged in the locking select itself: the request (a vendor's pickup) or the run (a rider's assignment) is joined to the stop, so a stop that is not the
  -- caller's, or that does not exist, is refused the same way without a row lock having been asked for on it (OB-S1-74 (2): another vendor could tell, by how long the answer
  -- took, that someone was working on a stop whose identifier it had guessed). The locks are the same locks in the same order as before (the stop, then its handshake).
  IF kind = 'VENDOR' THEN
    SELECT s.* INTO stop_row FROM public.pickup_stop AS s JOIN public.pickup_request AS r ON r.id = s.pickup_request_id
     WHERE s.id = p_stop AND r.vendor_organization_id = vendor FOR UPDATE OF s;
  ELSE
    SELECT s.* INTO stop_row FROM public.pickup_stop AS s JOIN public.pickup_manifest AS m ON m.id = s.pickup_manifest_id
     WHERE s.id = p_stop AND m.assigned_rider_id = rider FOR UPDATE OF s;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this is not a stop of the caller' USING ERRCODE = '42501';
  END IF;
  IF kind = 'RIDER' THEN
    -- The run's assignment is read again under the stop's lock, as it was before the locking select named it.
    SELECT m.state, m.assigned_rider_id INTO manifest_state, assigned FROM public.pickup_manifest AS m WHERE m.id = stop_row.pickup_manifest_id;
    IF NOT FOUND OR assigned IS DISTINCT FROM rider THEN
      RAISE EXCEPTION 'this is not a stop of the caller' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO record_row FROM public.collection_record AS c WHERE c.pickup_stop_id = p_stop;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the count is not recorded' USING ERRCODE = '23514', DETAIL = 'reason=COLLECTION_NOT_RECORDED';
  END IF;
  -- The counted-stop authority: the rider-side handshake of a counted stop belongs to the rider that recorded the count, while it is assigned (above).
  IF kind = 'RIDER' AND record_row.recorded_by <> rider THEN
    RAISE EXCEPTION 'the handshake of a counted stop is the recording rider''s' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.pickup_stop_id = p_stop FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no code has been asked for at this stop' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_NOT_STARTED';
  END IF;
  IF stop_row.state <> 'ARRIVED' OR h.state IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED') THEN
    RAISE EXCEPTION 'the handshake of this stop has ended' USING ERRCODE = '23514', DETAIL = 'reason=HANDSHAKE_CLOSED';
  END IF;
  -- The rung: the sender's code is entered by the rider alone; a vendor's primary code by the vendor alone.
  IF (h.direction = 'SENDER_SMS_RIDER_ENTERED' AND kind <> 'RIDER') OR (h.direction = 'VENDOR_ENTERED_RIDER_DISPLAYED' AND kind = 'RIDER' AND h.fallback_sends = 0) THEN
    RAISE EXCEPTION 'this code is not entered by this caller' USING ERRCODE = '23514', DETAIL = 'reason=WRONG_ENTRANT';
  END IF;
  before_state := h.state;
  IF h.state IN ('EXPIRED', 'EXHAUSTED') THEN
    outcome := CASE h.state WHEN 'EXPIRED' THEN 'CODE_EXPIRED' ELSE 'ATTEMPTS_EXHAUSTED' END;
  ELSE
    moment := pg_catalog.clock_timestamp();
    IF moment >= h.expires_at THEN
      UPDATE public.collection_handshake SET state = 'EXPIRED', code_digest = NULL WHERE id = h.id;
      outcome := 'CODE_EXPIRED';
    ELSIF h.code_digest = ANY (p_digests) THEN
      chosen_channel := CASE WHEN h.fallback_sends > 0 THEN 'SMS_FALLBACK' ELSE 'PORTAL' END;
      PERFORM melarc.handshake_settle(h.id, p_stop, NULL, 'VERIFIED', chosen_channel, NULL, moment);
      PERFORM melarc.handshake_event('pickup.handshake.verified', 'CollectionHandshake', h.id, h.responsible_hub_id, before_state, 'VERIFIED',
        pg_catalog.jsonb_build_object('pickup_stop_id', p_stop::text, 'pickup_manifest_id', stop_row.pickup_manifest_id::text, 'pickup_request_id', stop_row.pickup_request_id::text,
                                      'collection_record_id', record_row.id::text),
        pg_catalog.jsonb_build_object('direction', h.direction, 'channel', chosen_channel, 'attempts', h.attempts));
      outcome := 'VERIFIED';
    ELSE
      max_attempts := melarc.handshake_setting('handshake_max_wrong_attempts');
      IF h.attempts + 1 >= max_attempts THEN
        UPDATE public.collection_handshake SET attempts = attempts + 1, state = 'EXHAUSTED', code_digest = NULL WHERE id = h.id;
        outcome := 'ATTEMPTS_EXHAUSTED';
      ELSE
        UPDATE public.collection_handshake SET attempts = attempts + 1 WHERE id = h.id;
        outcome := 'CODE_INVALID';
      END IF;
    END IF;
  END IF;
  max_attempts := coalesce(max_attempts, melarc.handshake_setting('handshake_max_wrong_attempts'));
  SELECT * INTO h FROM public.collection_handshake AS x WHERE x.id = h.id;
  RETURN QUERY SELECT outcome, h.id, h.state, h.direction, h.channel, h.attempts, GREATEST(max_attempts - h.attempts, 0), h.expires_at, h.fallback_sends, h.authorised_by;
END
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.handshake_verify(uuid, bytea[]) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.handshake_verify(uuid, bytea[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.handshake_verify(uuid, bytea[]) TO melarc_api_runtime;
