import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Table, TableBody } from '../../primitives/table';
import { LOADING_ROW_WIDTHS, LoadingRow } from './LoadingRow';
import { SkeletonBar } from './SkeletonBar';
import { SkeletonCard } from './SkeletonCard';

describe('SkeletonBar', () => {
  // Break caught: a placeholder that a screen reader finds (it has no words, and the loading indicator is what says that the page is loading).
  it('is hidden from assistive technology and has no words', () => {
    const { container } = render(<SkeletonBar />);

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).toBe('');
  });

  // Break caught: the width and the height not reaching the bar, so that every bar is as wide as its room and as high as the default.
  it('takes the width and the height it is given, and none when it is given none', () => {
    const sized = render(<SkeletonBar width="60%" height="1rem" />);
    const bar = sized.container.firstElementChild as HTMLElement;
    expect(bar.style.width).toBe('60%');
    expect(bar.style.height).toBe('1rem');
    sized.unmount();

    const plain = render(<SkeletonBar />);
    const unsized = plain.container.firstElementChild as HTMLElement;
    expect(unsized.style.width).toBe('');
    expect(unsized.style.height).toBe('');
  });
});

describe('SkeletonCard', () => {
  // Break caught: a loading card that is read out, one bar for the title missing when it has a header, or a header drawn when it was not asked for.
  it('is decoration with a title bar and three lines by default', () => {
    const { container } = render(<SkeletonCard />);

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.ui-skeleton-card__header')).not.toBeNull();
    expect(container.querySelectorAll('.ui-skeleton-card__body .ui-skeleton-bar')).toHaveLength(3);
  });

  it('draws no title bar when it has no header', () => {
    const { container } = render(<SkeletonCard header={false} lines={2} />);

    expect(container.querySelector('.ui-skeleton-card__header')).toBeNull();
    expect(container.querySelectorAll('.ui-skeleton-bar')).toHaveLength(2);
  });

  // Break caught: a number of lines that no card can have (none, a fraction, a flood) drawn instead of refused, so that a bad count is a loading card of the wrong height.
  it.each([0, -1, 2.5, 9, Number.NaN])('refuses %j lines', (lines) => {
    expect(() => render(<SkeletonCard lines={lines} />)).toThrow(RangeError);
  });

  it.each([1, 8])('draws %i lines', (lines) => {
    const { container } = render(<SkeletonCard lines={lines} header={false} />);

    expect(container.querySelectorAll('.ui-skeleton-bar')).toHaveLength(lines);
  });
});

describe('LoadingRow', () => {
  function inTable(rows: ReactNode) {
    return render(
      <Table aria-label="Pickup requests">
        <TableBody>{rows}</TableBody>
      </Table>,
    );
  }

  // Break caught: a loading row with a different number of cells from the table it stands in, so that the columns jump when the rows arrive.
  it('has one cell and one bar per column', () => {
    const { container } = inTable(<LoadingRow columns={6} />);

    expect(container.querySelectorAll('tr')).toHaveLength(1);
    expect(container.querySelectorAll('td')).toHaveLength(6);
    expect(container.querySelectorAll('td .ui-skeleton-bar')).toHaveLength(6);
  });

  // Break caught: a loading row that a screen reader reads cell by cell, or one a pointer can hover and click as if it were a record.
  it('is hidden from assistive technology and cannot be pointed at', () => {
    const { container } = inTable(<LoadingRow columns={3} />);

    const row = container.querySelector('tr');
    expect(row).toHaveAttribute('aria-hidden', 'true');
    expect(row).toHaveClass('ui-loading-row');
  });

  // Break caught: the bars of a block of loading rows all the same width, which looks like a barcode; each row starts on a different width from the one above.
  it('starts each row on a different width from the row above', () => {
    const { container } = inTable(
      <>
        <LoadingRow columns={2} index={0} />
        <LoadingRow columns={2} index={1} />
      </>,
    );

    const rows = [...container.querySelectorAll('tr')].map((row) =>
      [...row.querySelectorAll<HTMLElement>('.ui-skeleton-bar')].map((bar) => bar.style.width),
    );
    expect(rows[0]).toEqual([LOADING_ROW_WIDTHS[0], LOADING_ROW_WIDTHS[1]]);
    expect(rows[1]).toEqual([LOADING_ROW_WIDTHS[1], LOADING_ROW_WIDTHS[2]]);
    expect(rows[0]).not.toEqual(rows[1]);
  });

  // Break caught: a table with more columns than there are widths running out of widths (an undefined width is a bar as wide as its cell).
  it('wraps round the widths when there are more columns than widths', () => {
    const { container } = inTable(<LoadingRow columns={LOADING_ROW_WIDTHS.length + 2} />);

    const widths = [...container.querySelectorAll<HTMLElement>('.ui-skeleton-bar')].map(
      (bar) => bar.style.width,
    );
    expect(widths).toHaveLength(LOADING_ROW_WIDTHS.length + 2);
    expect(widths.every((width) => width !== '')).toBe(true);
    expect(widths[LOADING_ROW_WIDTHS.length]).toBe(LOADING_ROW_WIDTHS[0]);
  });

  it('keeps a class the table gives it', () => {
    const { container } = inTable(
      <LoadingRow columns={1} className="ui-data-table__skeleton-row" />,
    );

    expect(container.querySelector('tr')).toHaveClass(
      'ui-loading-row',
      'ui-data-table__skeleton-row',
    );
  });

  // Break caught: a name, a role or a relationship the automated checks see is wrong with loading rows and a loading card on the page.
  it('has no automated WCAG violation', async () => {
    const { container } = render(
      <>
        <SkeletonCard />
        <Table aria-label="Pickup requests">
          <TableBody>
            <LoadingRow columns={4} index={0} />
            <LoadingRow columns={4} index={1} />
          </TableBody>
        </Table>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
