import { TableCell, TableRow } from '../../primitives/table';
import { SkeletonBar } from './SkeletonBar';

/** The widths that the bars of a row take in turn, so that a table of loading rows does not look like a barcode: 60, 80, 45, 70 and 55 per cent. */
export const LOADING_ROW_WIDTHS = ['60%', '80%', '45%', '70%', '55%'] as const;

export interface LoadingRowProps {
  /** How many cells the row has: the table's columns. */
  readonly columns: number;
  /** Which row of the loading rows this is, so that its bars start at a different width from the row above. */
  readonly index?: number;
  readonly className?: string;
}

/**
 * A row of a table that is loading (COMPONENT_PATTERNS, *LoadingRow*; the second half of redesign step R5): the shape of a DataTable row, a bar in each cell, so that the table keeps
 * its height and its columns while its rows are on the way and nothing jumps when they arrive. It is decoration (hidden from assistive technology); the table says in words that it
 * is loading.
 */
export function LoadingRow({ columns, index = 0, className }: LoadingRowProps) {
  return (
    <TableRow
      className={['ui-loading-row', className].filter((name) => name !== undefined).join(' ')}
      aria-hidden="true"
    >
      {Array.from({ length: columns }, (_cell, cell) => (
        <TableCell key={cell}>
          <SkeletonBar width={LOADING_ROW_WIDTHS[(index + cell) % LOADING_ROW_WIDTHS.length]} />
        </TableCell>
      ))}
    </TableRow>
  );
}
