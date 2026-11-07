import type { PickupRequestView } from '../../platform/pickup/pickup-shape';

/**
 * Sample data for the showcase of the kit, in the shape of the generated client's pickup request (the fields a queue reads: `PickupRequestView`, which is the
 * contract's type narrowed). Every one of them is made up: the names say "Sample", the codes are not the server's, and nothing here was read from anywhere.
 */
export type SampleRequest = Pick<
  PickupRequestView,
  'id' | 'code' | 'state' | 'scheduled_service_date' | 'declared_package_count' | 'sender_name'
>;

const NAMES = [
  'Sample Fabrics Ltd',
  'Sample Bakery',
  'Sample Pharmacy',
  'Sample Books',
  'Sample Florist',
  'Sample Hardware',
  'Sample Tailor',
  'Sample Printers',
] as const;

const CODES = [
  'ACC-PR-7KQ2MZ',
  'ACC-PR-4HT9WD',
  'ACC-PR-2MX8RC',
  'ACC-PR-9WXH4T',
  'ACC-PR-3NP6VB',
  'ACC-PR-8DF5GJ',
  'ACC-PR-6LC3QY',
  'ACC-PR-5RB7ZK',
  'ACC-PR-2TJ4HN',
  'ACC-PR-7VG9MD',
  'ACC-PR-4XK2PW',
  'ACC-PR-9QZ6CF',
  'ACC-PR-3BM8SA',
  'ACC-PR-6HW5RE',
  'ACC-PR-8YN3DX',
  'ACC-PR-5FP9LT',
  'ACC-PR-2CV7KJ',
  'ACC-PR-7ZD4WQ',
  'ACC-PR-4GS6NB',
  'ACC-PR-9MA2YH',
] as const;

const STATES = ['PENDING', 'CONFIRMED', 'CONFIRMED', 'PENDING', 'CANCELLED', 'CONFIRMED'] as const;
const DATES = [
  '2026-11-09',
  '2026-11-10',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-09',
] as const;

/** The first `count` sample requests, from 1 to 20: the same ones in the same order every time. */
export function sampleRequests(count: number): SampleRequest[] {
  return CODES.slice(0, Math.min(count, CODES.length)).map((code, index) => ({
    id: `sample-${String(index + 1).padStart(2, '0')}`,
    code,
    state: STATES[index % STATES.length] ?? 'PENDING',
    scheduled_service_date: DATES[index % DATES.length] ?? '2026-11-09',
    declared_package_count: (index % 5) + 1,
    sender_name: NAMES[index % NAMES.length] ?? 'Sample sender',
  }));
}
