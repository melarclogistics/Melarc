-- STAGE 7, THE PRICING CHECK (the review of 22 November 2026, finding 5; OB-S1-163; contract 5.118.0).
--
-- A save that waits for the intake (or for the request's payer arrangement) used to compare the hub's configuration by what was STORED: `0119` hashed every row of the hub's settings, zones and aliases. Three cases
-- passed that check with the old rate, and a fresh read would have given the new one:
--   1. A rate version that already existed took effect while the save waited. Nothing stored changed, so the digest was the same, and the reader's `effective_from <= moment` chose the old version.
--   2. A version committed between the reader's instant and its digest: the digest already held the row that the selection (made at the earlier instant) left out.
--   3. The fee changed while the save waited for the PAYER: the comparison came before that wait.
-- And the company-wide rules (the declaration threshold decides whether a booking acknowledgement is needed) were not in the digest at all.
--
-- The digest is now of the configuration IN FORCE at an instant, and of everything the price reads: for each key and scope the version in force at the instant (the reader's own selection: the greatest `effective_from`
-- not after it, then the greatest version), the hub's zones and aliases, and the COMPANY-scope rules. It is computed by ONE statement, so it is one consistent read. The reader asks it at the instant it selects the rates at,
-- in the snapshot it reads them in; the save asks it at the moment it holds both locks (`clock_timestamp()`), so a version that took effect in between, or one that committed in between, is a different digest and the save
-- reads the configuration again. The service now takes the payer's lock before it compares (the change is in the service).
--
-- NO PERMISSION CHANGES. The function runs with the rights of its caller, as `0119`'s did, and returns a digest and no value: the configuration reader (the `configuration` capability: the hub's rows and the COMPANY rules)
-- and a staff context (the hub's rows of its scope, and `setting`, which every staff context reads, `0003`) see the same rows and so ask the same question. No policy is added or changed.
--
-- The old function took the hub alone and is dropped: nothing else calls it, and a second overload would be a way to ask the question the old way.

DROP FUNCTION melarc.hub_configuration_fingerprint(uuid);
--> statement-breakpoint
CREATE FUNCTION melarc.hub_configuration_fingerprint(p_hub uuid, p_at timestamp with time zone) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.md5(
    coalesce((
      SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.to_jsonb(s)::text), ',' ORDER BY s.setting_key, s.scope_ref)
        FROM (
          SELECT DISTINCT ON (h.setting_key, h.scope_ref) h.*
            FROM public.hub_setting AS h
           WHERE h.hub_id = p_hub AND h.effective_from <= p_at
           ORDER BY h.setting_key, h.scope_ref, h.effective_from DESC, h.version DESC
        ) AS s), '')
    || '|' || coalesce((SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.to_jsonb(z)::text), ',' ORDER BY z.id) FROM public.service_zone AS z WHERE z.hub_id = p_hub), '')
    || '|' || coalesce((SELECT pg_catalog.string_agg(pg_catalog.md5(pg_catalog.to_jsonb(a)::text), ',' ORDER BY a.id) FROM public.service_zone_alias AS a WHERE a.hub_id = p_hub), '')
    || '|' || coalesce((
      SELECT pg_catalog.string_agg(
               pg_catalog.md5(pg_catalog.jsonb_build_object('key', c.key, 'value_type', c.value_type, 'value', c.value, 'unit', c.unit)::text),
               ',' ORDER BY c.key)
        FROM public.setting AS c
       WHERE c.scope = 'COMPANY'), ''))
$$;
--> statement-breakpoint
ALTER FUNCTION melarc.hub_configuration_fingerprint(uuid, timestamp with time zone) OWNER TO melarc_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION melarc.hub_configuration_fingerprint(uuid, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION melarc.hub_configuration_fingerprint(uuid, timestamp with time zone) TO melarc_api_runtime;
