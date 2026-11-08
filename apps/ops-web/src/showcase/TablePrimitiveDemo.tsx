import { useState } from 'react';

import { Badge } from '@/components/primitives/badge';
import { Checkbox } from '@/components/primitives/checkbox';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/primitives/table';

/*
 * The table primitive of shadcn/ui as it is drawn: a caption, a header, rows, a state in a Badge and a box to choose a row with. It is the primitive alone, with
 * no data-table behaviour (no sorting, no row model): that is the kit's `DataTable`, the one place that imports TanStack Table (task R5.2, M9; the door of
 * COMPONENT_PATTERNS section 37), and its own showcase page is the kit's. Nothing here is the queue: the rows are synthetic, nothing is fetched, and the
 * choice is the browser's to show and decides nothing (the server is authoritative about a request and its state).
 */
type DemoState = 'Draft' | 'Confirmed' | 'Dispatched' | 'Delivered' | 'Delayed';

interface DemoRequest {
  readonly reference: string;
  readonly vendor: string;
  readonly hub: string;
  readonly state: DemoState;
  readonly pickupDate: string;
}

const REQUESTS: readonly DemoRequest[] = [
  {
    reference: 'DEMO-0104',
    vendor: 'Demo Bakery',
    hub: 'Accra Central',
    state: 'Confirmed',
    pickupDate: '2026-11-09',
  },
  {
    reference: 'DEMO-0101',
    vendor: 'Demo Pharmacy',
    hub: 'Tema',
    state: 'Dispatched',
    pickupDate: '2026-11-06',
  },
  {
    reference: 'DEMO-0107',
    vendor: 'Demo Books',
    hub: 'Accra Central',
    state: 'Draft',
    pickupDate: '2026-11-12',
  },
  {
    reference: 'DEMO-0102',
    vendor: 'Demo Tailor',
    hub: 'Kumasi',
    state: 'Delivered',
    pickupDate: '2026-11-05',
  },
  {
    reference: 'DEMO-0103',
    vendor: 'Demo Florist',
    hub: 'Tema',
    state: 'Delayed',
    pickupDate: '2026-11-06',
  },
  {
    reference: 'DEMO-0105',
    vendor: 'Demo Hardware',
    hub: 'Kumasi',
    state: 'Confirmed',
    pickupDate: '2026-11-10',
  },
];

const STATE_BADGE = {
  Draft: 'neutral',
  Confirmed: 'info',
  Dispatched: 'info',
  Delivered: 'success',
  Delayed: 'warning',
} as const satisfies Record<DemoState, 'neutral' | 'info' | 'success' | 'warning'>;

export function TablePrimitiveDemo() {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const allChosen = chosen.length === REQUESTS.length;

  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableCaption>
          Synthetic pickup requests.{' '}
          {chosen.length === 0 ? 'None chosen.' : `${String(chosen.length)} chosen.`}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Checkbox
                aria-label="Select all demo requests"
                checked={allChosen ? true : chosen.length > 0 ? 'indeterminate' : false}
                onCheckedChange={(value) => {
                  setChosen(value === true ? REQUESTS.map((request) => request.reference) : []);
                }}
              />
            </TableHead>
            <TableHead>Request</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Hub</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Pickup date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {REQUESTS.map((request) => {
            const isChosen = chosen.includes(request.reference);
            return (
              <TableRow key={request.reference} data-state={isChosen ? 'selected' : undefined}>
                <TableCell>
                  <Checkbox
                    aria-label={`Select ${request.reference}`}
                    checked={isChosen}
                    onCheckedChange={(value) => {
                      setChosen((current) =>
                        value === true
                          ? [...current, request.reference]
                          : current.filter((reference) => reference !== request.reference),
                      );
                    }}
                  />
                </TableCell>
                <TableCell>{request.reference}</TableCell>
                <TableCell>{request.vendor}</TableCell>
                <TableCell>{request.hub}</TableCell>
                <TableCell>
                  <Badge variant={STATE_BADGE[request.state]}>{request.state}</Badge>
                </TableCell>
                <TableCell>{request.pickupDate}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
