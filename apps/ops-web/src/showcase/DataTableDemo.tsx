import { useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';

import { Badge } from '@/components/primitives/badge';
import { Button } from '@/components/primitives/button';
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
import { Icon } from '../components/ui/icon/Icon';

/*
 * The data-table pattern of shadcn/ui (TanStack Table over the table primitive), as the queue grid will be built from in step R5: the table keeps its
 * state in the hook (sorting, selection), the primitive draws it. Nothing here is the queue: the rows are synthetic, nothing is fetched, and the order
 * and the selection are the browser's to show and decide nothing (the server is authoritative about a request and its state).
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

/** A column header that sorts: a button, so that the keyboard sorts it, and `aria-sort` on the cell so that the order is told in words. */
function SortHeader({
  column,
  children,
}: {
  readonly column: Column<DemoRequest>;
  readonly children: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        column.toggleSorting(sorted === 'asc');
      }}
    >
      {children}
      <Icon
        name={
          sorted === 'asc' ? 'sort-ascending' : sorted === 'desc' ? 'sort-descending' : 'sort-none'
        }
        size="sm"
      />
    </Button>
  );
}

const COLUMNS: ColumnDef<DemoRequest>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all demo requests"
        checked={
          table.getIsAllRowsSelected()
            ? true
            : table.getIsSomeRowsSelected()
              ? 'indeterminate'
              : false
        }
        onCheckedChange={(value) => {
          table.toggleAllRowsSelected(value === true);
        }}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={`Select ${row.original.reference}`}
        checked={row.getIsSelected()}
        onCheckedChange={(value) => {
          row.toggleSelected(value === true);
        }}
      />
    ),
    enableSorting: false,
  },
  { accessorKey: 'reference', header: 'Request', enableSorting: false },
  {
    accessorKey: 'vendor',
    header: ({ column }) => <SortHeader column={column}>Vendor</SortHeader>,
  },
  { accessorKey: 'hub', header: 'Hub', enableSorting: false },
  {
    accessorKey: 'state',
    header: 'State',
    enableSorting: false,
    cell: ({ row }) => (
      <Badge variant={STATE_BADGE[row.original.state]}>{row.original.state}</Badge>
    ),
  },
  {
    accessorKey: 'pickupDate',
    header: ({ column }) => <SortHeader column={column}>Pickup date</SortHeader>,
  },
];

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

export function DataTableDemo() {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  // TanStack Table's hook returns functions that the React Compiler cannot memoize. This application does not use the compiler, and the table is
  // read afresh from its state on every render, which is what the library documents.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: REQUESTS as DemoRequest[],
    columns: COLUMNS,
    state: { sorting, rowSelection: selection },
    onSortingChange: setSorting,
    onRowSelectionChange: setSelection,
    getRowId: (row) => row.reference,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const chosen = table.getSelectedRowModel().rows.length;

  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableCaption>
          Synthetic pickup requests. {chosen === 0 ? 'None chosen.' : `${String(chosen)} chosen.`}
        </TableCaption>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={sorted === false ? undefined : ARIA_SORT[sorted]}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
