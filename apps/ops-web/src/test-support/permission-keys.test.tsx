import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { watchPermissionKeys } from './permission-keys';
import { renderApp } from './render-app';
import { renderWithProviders } from './render-providers';

/** The keys the watch found while `draw` ran, without the places. */
function keysDrawnBy(draw: () => void): string[] {
  const watch = watchPermissionKeys();
  draw();
  return watch.finish().map((hit) => hit.split(' in ')[0] ?? '');
}

describe('the watch for a permission key on the screen', () => {
  // Break caught: a watch that reads the text and not the attributes (a key in an aria-label, a title, a link or a data attribute is as much on the screen to a person
  // who hovers, or listens, or inspects, and to a test), or one that reads the attributes and not the text.
  it('finds a key in the text of an element and in every kind of attribute', () => {
    const found = keysDrawnBy(() => {
      render(
        <div>
          <p>pickup.read</p>
          <button type="button" aria-label="staff.read">
            Go
          </button>
          <a href="/x?need=vendor.read" title="dispatch.read" data-note="fleet.custody.read">
            More
          </a>
        </div>,
      );
    });
    expect(found.sort()).toEqual([
      'dispatch.read',
      'fleet.custody.read',
      'pickup.read',
      'staff.read',
      'vendor.read',
    ]);
  });

  // Break caught: a watch that looks once at what is drawn and not at what is drawn later (a dialog opened and closed, a message that appears and goes), which is where
  // a key that is put together at run time is likely to be.
  it('finds a key that is drawn only for a moment, and one that a text or an attribute is changed to', async () => {
    const watch = watchPermissionKeys();
    function Moving() {
      const [step, setStep] = useState(0);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setStep(step + 1);
            }}
          >
            Next
          </button>
          {step === 1 ? <p>pickup.request.create</p> : null}
          <span title={step === 2 ? 'staff.mfa.reset' : 'plain'}>
            {step === 3 ? 'vendor.read' : 'plain'}
          </span>
        </div>
      );
    }
    render(<Moving />);
    const next = screen.getByRole('button', { name: 'Next' });
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        next.click();
        await Promise.resolve();
      });
    }
    // By now the first key is long gone from the page.
    expect(screen.queryByText('pickup.request.create')).toBeNull();
    const found = watch.finish().map((hit) => hit.split(' in ')[0]);
    expect(found.sort()).toEqual(['pickup.request.create', 'staff.mfa.reset', 'vendor.read']);
  });

  // Break caught: a watch that does not read the head of the document, where the title of a page is drawn.
  it('finds a key in the title of the page', () => {
    expect(
      keysDrawnBy(() => {
        render(<title>pickup.read · Melarc</title>);
      }),
    ).toEqual(['pickup.read']);
  });

  // Break caught: a watch so strict that a sentence ending in a key is missed (the full stop after it is not part of the name).
  it('finds a key at the end of a sentence', () => {
    expect(
      keysDrawnBy(() => {
        render(<p>This needs pickup.read.</p>);
      }),
    ).toEqual(['pickup.read']);
  });

  // Break caught: a watch so loose that it flags words (the refusals are told in plain words, and a longer name or a code is not a key).
  it('finds nothing in plain words, a longer name or a code', () => {
    expect(
      keysDrawnBy(() => {
        render(
          <div>
            <p>Your account can’t see pickup requests. Ask an administrator for access.</p>
            <p>pickup.readable and xpickup.read and made.up.key and pickup.read_all</p>
            <p>{`pickup.request.create_later`}</p>
          </div>,
        );
      }),
    ).toEqual([]);
  });

  // Break caught: a watch that reads code as a screen (a style sheet or a script of the page names things that are not drawn).
  it('does not read a script or a style', () => {
    expect(
      keysDrawnBy(() => {
        const script = document.createElement('script');
        script.textContent = 'const need = "pickup.read";';
        const style = document.createElement('style');
        style.textContent = '/* pickup.read */ p { color: red; }';
        document.head.append(script, style);
        script.remove();
        style.remove();
      }),
    ).toEqual([]);
  });
});

describe('a page test that draws a key', () => {
  // Break caught: a render helper that does not watch, so that a page which put a key together at run time passed every page test. Each of the next two must FAIL (`it.fails`
  // passes only when the test fails), and the third, which draws the words of a refusal, must pass.
  it.fails('is failed by the providers helper', () => {
    renderWithProviders(<p>You need pickup.read to see this.</p>);
  });

  it.fails('is failed by the application helper', async () => {
    renderApp('/later', [{ path: 'later', element: <h1 title="staff.read">The page</h1> }]);
    await screen.findByRole('heading', { level: 1, name: 'The page' });
  });

  it('is not failed by the words of a refusal', () => {
    renderWithProviders(
      <p>Your account can’t see pickup requests. Ask an administrator for access.</p>,
    );
    expect(screen.getByText(/can’t see pickup requests/)).toBeVisible();
  });
});
