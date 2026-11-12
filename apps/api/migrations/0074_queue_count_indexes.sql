-- Task C1 (Ops Portal queue summary, 5 November 2026): the indexes the counts of `getQueueSummary` read. Read as the plans of the six counts at 400,000 requests, 380,000
-- stops and 5,000 profiles (PostgreSQL 18), under the runtime role and the real security context. A forward migration; it changes no table, no column and no policy.
--
--   * pickup_request_cutoff_review_idx: the late bookings waiting for the cutoff decision (a few rows among every confirmed request): a sequential scan of the table (98 ms) becomes
--     an index scan of the few.
--   * one_package_exception_state_idx and pickup_request_carried_exception_idx: the exceptions in a state, and the requests that carry one. The filter on the state of the exception
--     (`listPickupRequests`, `one_package_exception_state`, and the approver's queue count) now starts from them instead of asking every request which exception it shows (246 seconds
--     at this scale for one call).
--   * one_package_exception_request_idx: every exception of a request, newest first, the refused ones included (the live index holds only the requested and the approved).
--   * staff_identity_pending_approval_idx: the profiles waiting for approval (a sequential scan of the profiles).
CREATE INDEX "staff_identity_pending_approval_idx" ON "staff_identity" USING btree ("created_at") WHERE "staff_identity"."status" = 'PENDING_APPROVAL';--> statement-breakpoint
CREATE INDEX "one_package_exception_state_idx" ON "one_package_exception" USING btree ("state","requested_at");--> statement-breakpoint
CREATE INDEX "one_package_exception_request_idx" ON "one_package_exception" USING btree ("pickup_request_id","requested_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pickup_request_cutoff_review_idx" ON "pickup_request" USING btree ("responsible_hub_id","confirmed_at") WHERE "pickup_request"."state" = 'CONFIRMED' AND "pickup_request"."cutoff_exception_state" = 'PENDING_OPS_REVIEW';--> statement-breakpoint
CREATE INDEX "pickup_request_carried_exception_idx" ON "pickup_request" USING btree ("one_package_exception_id") WHERE "pickup_request"."one_package_exception_id" IS NOT NULL;