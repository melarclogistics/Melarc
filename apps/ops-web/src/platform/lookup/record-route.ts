import type { LookupKindName } from './record-lookup-shape';
import { uuidOf } from '../staff/staff-shape';

/**
 * The page that opens each kind of record the lookup finds, by the id that kind's own read is addressed by (a vendor account's, for a vendor).
 * **The Ops Portal's own mapping** (`AC-LOOKUP-12`, the Product Owner's decision D1 of 6 November 2026): the API names no page, so the pages
 * and the words of a result have one owner, and a rename of a page changes one table here, held to the route registry by `record-route.test.ts`.
 * The mapping is complete for the contract's kinds at compile time (`Record<LookupKindName, …>`), so a kind the contract adds is not a result
 * with nowhere to go.
 */
const PAGES: Readonly<Record<LookupKindName, (id: string) => string>> = {
  PICKUP_REQUEST: (id) => `/pickup-requests/${id}`,
  PICKUP_MANIFEST: (id) => `/manifests/${id}`,
  VENDOR_ACCOUNT: (id) => `/admin/vendors/${id}`,
  RIDER: (id) => `/admin/riders/${id}`,
  STAFF_IDENTITY: (id) => `/admin/staff/${id}`,
};

/**
 * The path of the page that opens a record, or nothing for an id that is not an identifier: a text of the answer never becomes part of a path
 * (a way out of the page, a query, another site).
 */
export function recordRoute(kind: LookupKindName, id: string): string | undefined {
  const identifier = uuidOf(id);
  return identifier === undefined ? undefined : PAGES[kind](identifier);
}
