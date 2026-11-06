-- Task C2 (Ops Portal global lookup, 6 November 2026): the indexes the search by a phone number typed in full reads (`lookupRecords`, features/operations/global-lookup.md).
-- Read as the plans of the search at 400,030 requests (PostgreSQL 18), under the runtime role and the real security context. A forward migration; it changes no table, no column
-- and no policy.
--
--   * pickup_request_primary_phone_idx and pickup_request_secondary_phone_idx: a request is found by either of its contact phones. An equality on a text is leakproof, so the planner
--     runs it, and may use an index on it, before the row-level security policy (it cannot do either for an ILIKE, which is why the name search has no index: the feature, section 14).
--     Without them the search is a sequential scan of the table (0.1 s in the plan, a median of 85 to 150 ms for the whole read, at this scale); with them the plan takes 0.2 ms and the
--     whole read a median of about 20 ms. The second is partial: most requests have no second number.
CREATE INDEX "pickup_request_primary_phone_idx" ON "pickup_request" USING btree ("primary_phone");--> statement-breakpoint
CREATE INDEX "pickup_request_secondary_phone_idx" ON "pickup_request" USING btree ("secondary_phone") WHERE "pickup_request"."secondary_phone" IS NOT NULL;
