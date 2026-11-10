import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { Builder, BuilderRunList, type BuilderProps, type BuilderRunItem } from './Builder';

const ITEMS: readonly BuilderRunItem[] = [
  {
    id: 'a',
    code: 'ACC-PR-7KQ2MZ',
    title: 'Sample Fabrics Ltd',
    detail: 'Mon 9 Nov 2026',
    refusal: 'Another manifest holds this request.',
    remove: { label: 'Remove ACC-PR-7KQ2MZ from the choice', onClick: () => undefined },
  },
  {
    id: 'b',
    code: 'ACC-PR-4HT9WD',
    title: 'Sample Bakery',
    stale: 'It is no longer waiting for a manifest.',
    remove: { label: 'Remove ACC-PR-4HT9WD from the choice', onClick: () => undefined },
  },
  { id: 'c', code: 'ACC-PR-2MX8RC', title: 'Sample Pharmacy' },
];

function props(overrides: Partial<BuilderProps> = {}): BuilderProps {
  return {
    header: { title: 'Build a manifest' },
    onSubmit: (event) => {
      event.preventDefault();
    },
    panes: {
      pool: { title: 'The pool of confirmed pickups', children: <p>The pool’s rows.</p> },
      run: {
        title: 'The run',
        summary: '3 requests chosen.',
        totals: [{ label: 'Stops chosen', value: '3' }, { label: 'Distance' }],
        children: (
          <BuilderRunList
            label="The requests chosen, in order"
            items={ITEMS}
            emptyText="Choose requests from the pool."
          />
        ),
        actions: <Button type="submit">Create the manifest</Button>,
      },
    },
    ...overrides,
  };
}

function renderBuilder(overrides: Partial<BuilderProps> = {}) {
  return render(
    <MemoryRouter>
      <Builder {...props(overrides)} />
    </MemoryRouter>,
  );
}

describe('Builder', () => {
  // Break caught: a builder that draws one pane, or the two out of their meaning (the pool to choose from, then the run that was chosen), or loses the setup above them.
  it('draws the setup, the pool and the run', () => {
    renderBuilder({ setup: <p>The hub of the run.</p> });

    expect(screen.getByText('The hub of the run.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'The pool of confirmed pickups' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'The run' })).toBeVisible();
    expect(screen.getByText('The pool’s rows.')).toBeVisible();
    const summary = screen.getByText('3 requests chosen.', { selector: '.ui-builder__summary' });
    expect(summary).toHaveAttribute('role', 'status');
  });

  // Break caught: panes drawn before there is a hub (a pool of nothing), or no word to say why they are not there.
  it('draws the note and no panes while the page gives none', () => {
    renderBuilder({ panes: undefined, note: 'Choose the hub first: the pool is that hub’s.' });

    expect(screen.getByText('Choose the hub first: the pool is that hub’s.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'The run' })).toBeNull();
  });

  // Break caught: a refusal drawn away from the row it names, a stale row dropped or drawn like the others, or either told by colour alone.
  it('draws a refusal and a stale flag on the row they name, in words, and keeps every row', () => {
    renderBuilder();

    const list = screen.getByRole('list', { name: 'The requests chosen, in order' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const [refused = list, stale = list] = rows;
    expect(rows[0]).toHaveAttribute('data-refused', 'true');
    expect(within(refused).getByText('Another manifest holds this request.')).toBeVisible();
    expect(rows[1]).toHaveAttribute('data-stale', 'true');
    expect(within(stale).getByText('It is no longer waiting for a manifest.')).toBeVisible();
    // The words reach assistive technology with the row, and the third row has none.
    expect(rows[0]).toHaveAccessibleDescription(/Another manifest holds this request/);
    expect(rows[2]).not.toHaveAttribute('aria-describedby');
    expect(rows[2]).not.toHaveAttribute('data-refused');
  });

  // Break caught: a remove button that does not say which row it takes out, or one that does nothing.
  it('takes a row out with a button that names the row', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <BuilderRunList
        label="The requests chosen, in order"
        emptyText="Nothing."
        items={[
          {
            id: 'a',
            code: 'ACC-PR-7KQ2MZ',
            title: 'Sample Fabrics Ltd',
            remove: { label: 'Remove ACC-PR-7KQ2MZ from the choice', onClick },
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove ACC-PR-7KQ2MZ from the choice' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Break caught: a total that was not stated, drawn as a 0 or a dash that reads as an answer.
  it('says in words that a total was not stated, never as 0', () => {
    renderBuilder();

    expect(screen.getByText('Not recorded')).toBeVisible();
  });

  // Break caught: an empty run that draws an empty list, or says nothing about what to do.
  it('says what to do while nothing is chosen', () => {
    render(
      <BuilderRunList
        label="The requests chosen"
        items={[]}
        emptyText="Choose requests from the pool."
      />,
    );

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('Choose requests from the pool.')).toBeVisible();
  });

  // Break caught: a one-column layout (the tablet) with no way to reach the run from the pool, or one that does not move focus to what it scrolled to.
  it('goes to the run from the pool’s header and puts focus on its heading', async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = () => undefined;
    renderBuilder();

    await user.click(screen.getByRole('button', { name: 'Go to the run: 3 requests chosen.' }));
    expect(screen.getByRole('heading', { level: 2, name: 'The run' })).toHaveFocus();
  });

  // Break caught: a submit that does not reach the page, or a form marked busy when it is not.
  // Break caught (the Product Owner, 9 November 2026, Stage 3 item 8): the run's actions among the rows they act on, so that where the pane scrolls inside they scroll away with them: they are
  // the pane's own footer, after the part that scrolls, and the footer is not in it.
  it('draws the run’s actions in the pane’s own footer, after the part of the pane that scrolls', () => {
    const { container } = renderBuilder();

    const footer = container.querySelector('.ui-builder__footer');
    const body = container.querySelector('.ui-builder__run-body');
    if (footer === null || body === null) throw new Error('the run has no footer or no body');
    expect(
      within(footer as HTMLElement).getByRole('button', { name: 'Create the manifest' }),
    ).toBeVisible();
    expect(body).not.toContainElement(footer as HTMLElement);
    expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hands the submit to the page and says it is busy while it is sent', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const { container } = renderBuilder({ onSubmit, busy: true });
    expect(container.querySelector('form')).toHaveAttribute('aria-busy', 'true');

    await user.click(screen.getByRole('button', { name: 'Create the manifest' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // Break caught: a composition that fails a WCAG 2.2 rule with refusals, a stale row and totals drawn.
  it('has no accessibility violation with a refusal, a stale row and totals', async () => {
    const { container } = renderBuilder({ setup: <p>The hub of the run.</p> });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
