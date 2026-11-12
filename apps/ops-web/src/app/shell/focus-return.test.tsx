import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { pressWithoutFocus } from '../../test-support/press';
import { useFocusReturn } from './focus-return';

/** What a dialog of the shell does with the hook: remember when it opens, and let it decide where focus goes when it has closed. */
function Harness({ onResult }: { onResult: (api: ReturnType<typeof useFocusReturn>) => void }) {
  const fallback = useRef<HTMLButtonElement>(null);
  const api = useFocusReturn(fallback);
  onResult(api);
  return (
    <>
      <button type="button">Pressed to open it</button>
      <button type="button" ref={fallback}>
        The button of the top bar
      </button>
    </>
  );
}

function setup() {
  let api: ReturnType<typeof useFocusReturn> | undefined;
  render(
    <MemoryRouter>
      <Harness
        onResult={(value) => {
          api = value;
        }}
      />
    </MemoryRouter>,
  );
  if (api === undefined) throw new Error('The harness did not draw.');
  return api;
}

describe('useFocusReturn: the control a dialog without a trigger of its own goes back to', () => {
  // Break caught (Safari, decision of 10 November 2026): the control read from the element that has focus, which is the body after a press in Safari's engine, so a dialog
  // opened from a control other than the one the page names as its fallback sent focus to the fallback.
  it('is the control that was pressed, in an engine that gives a pressed button no focus', () => {
    const { remember, onCloseAutoFocus } = setup();
    pressWithoutFocus(screen.getByRole('button', { name: 'Pressed to open it' }));
    remember();

    let prevented = false;
    onCloseAutoFocus({
      preventDefault: () => {
        prevented = true;
      },
    } as Event);

    expect(prevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Pressed to open it' })).toHaveFocus();
  });

  // Break caught: no way back when nothing was pressed and nothing had focus (a shortcut on a page nobody has touched): the page's own control is the way back.
  it('is the fallback when nothing was pressed and nothing had focus', () => {
    const { remember, onCloseAutoFocus } = setup();
    remember();

    onCloseAutoFocus({ preventDefault: () => undefined } as Event);

    expect(screen.getByRole('button', { name: 'The button of the top bar' })).toHaveFocus();
  });
});
