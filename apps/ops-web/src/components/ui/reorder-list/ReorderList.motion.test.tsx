import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReorderList } from './ReorderList';

// A stand-in for the list item of Motion, which draws what the list asked of it as attributes: whether the item glides to its new place when the order
// changes, and for how long. (Motion measures boxes to glide; jsdom has none, so what a browser does is `kit.spec.ts`'s to show, and what the list asks for
// is shown here.) Everything else of the motion door is the real one, the hook that reads the preference included.
vi.mock('../motion/motion', async (importOriginal) => {
  const original = await importOriginal<typeof import('../motion/motion')>();
  return {
    ...original,
    motion: {
      li: (props: {
        readonly layout?: boolean | string;
        readonly transition?: { readonly layout?: { readonly duration?: number } };
        readonly className?: string;
        readonly children?: ReactNode;
      }) => (
        <li
          className={props.className}
          data-layout={String(props.layout)}
          data-duration={String(props.transition?.layout?.duration)}
        >
          {props.children}
        </li>
      ),
    },
  };
});

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

const ITEMS = [
  { id: 'a', label: 'Stop 1, ACC-PR-7KQ2MZ', content: <span>First</span> },
  { id: 'b', label: 'Stop 2, ACC-PR-4HT9WD', content: <span>Second</span> },
];

const items = (): HTMLElement[] =>
  screen.getAllByRole('listitem').filter((item) => item.hasAttribute('data-layout'));

describe('ReorderList, the glide of a move', () => {
  // Break caught: items that jump to their new place (no layout animation asked of Motion), or that animate their size as well as their place, or over a time
  // of their own and not the motion token's 200ms.
  it('asks every item to glide to its new place, over the motion token, by position only', () => {
    setReducedMotion(false);
    render(<ReorderList label="Stops" items={ITEMS} onChange={vi.fn()} />);

    expect(items().map((item) => item.getAttribute('data-layout'))).toEqual([
      'position',
      'position',
    ]);
    expect(items().map((item) => item.getAttribute('data-duration'))).toEqual(['0.2', '0.2']);
  });

  // Break caught: a list that glides for a person who asked the system for less motion.
  it('asks for no glide when the person asked the system for less motion', () => {
    setReducedMotion(true);
    render(<ReorderList label="Stops" items={ITEMS} onChange={vi.fn()} />);

    expect(items().map((item) => item.getAttribute('data-layout'))).toEqual(['false', 'false']);
  });
});
