import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from './Button';

describe('Button', () => {
  // Break caught: a button that submits a form it was never meant to, because no type was set.
  it('is a native button and always says its type', () => {
    render(
      <>
        <Button type="button">Cancel</Button>
        <Button type="submit">Save</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
  });

  it('is primary unless told otherwise, and can be secondary', () => {
    render(
      <>
        <Button type="button">Primary</Button>
        <Button type="button" variant="secondary">
          Secondary
        </Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Primary' })).toHaveClass('ui-button--primary');
    expect(screen.getByRole('button', { name: 'Secondary' })).toHaveClass('ui-button--secondary');
  });

  // Break caught: an action that works with the mouse and not the keyboard.
  it('is reached by Tab and activated by Enter and by Space', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button type="button" onClick={onClick}>
        Try again
      </Button>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('passes through the attributes that give it a name and a description', () => {
    render(
      <Button type="button" aria-describedby="hint" aria-label="Retry the request">
        Retry
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Retry the request' });
    expect(button).toHaveAttribute('aria-describedby', 'hint');
  });
});

describe('Button: the attributes a caller sets', () => {
  // Break caught: the button overwriting an ARIA state the caller set, when it is not the one loading owns.
  it('keeps aria-busy and aria-disabled that the caller set while it is not loading', () => {
    render(
      <Button type="button" aria-busy="false" aria-disabled="true">
        Save
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('says it is busy and inert while loading, whatever the caller set', () => {
    render(
      <Button type="button" loading aria-busy="false" aria-disabled="false">
        Saving…
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Button: disabled', () => {
  // Break caught: disabled styling without disabled behaviour (DESIGN: "not use disabled styling without disabled behavior").
  it('uses the native attribute, cannot be activated and is skipped by Tab', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button type="button" disabled onClick={onClick}>
          Save
        </Button>
        <Button type="button">After</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.tab();

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });
});

describe('Button: loading', () => {
  // Break caught: a second submission while the first is still being answered, or a button that loses keyboard
  // focus the moment it starts loading (the native disabled attribute does that).
  it('ignores activation, keeps focus and says it is busy', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button type="button" loading onClick={onClick}>
        Saving…
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving…' });

    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
  });

  // Break caught: a loading submit button that still submits its form.
  it('does not submit the form it sits in', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Saving…
        </Button>
      </form>,
    );

    await user.click(screen.getByRole('button', { name: 'Saving…' }));
    await user.keyboard('{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Break caught: the other way into a submit, pressing Enter in a field, still sending the form while the submit button
  // is loading (the browser clicks the form's default button, and that click must be refused too).
  it('does not submit the form when Enter is pressed in a field of it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="Name" />
        <Button type="submit" loading>
          Saving…
        </Button>
      </form>,
    );

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ama{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits normally when it is not loading', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // Break caught: a spinner that is read out as content, or that replaces the label, so the name is lost.
  it('keeps its label as its name and hides the spinner from assistive technology', () => {
    const { container } = render(
      <Button type="button" loading>
        Saving…
      </Button>,
    );

    expect(screen.getByRole('button')).toHaveAccessibleName('Saving…');
    const spinner = container.querySelector('.ui-spinner');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows no spinner when it is not loading', () => {
    const { container } = render(<Button type="button">Save</Button>);

    expect(container.querySelector('.ui-spinner')).toBeNull();
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });
});

describe('Button: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in any state', async () => {
    const { container } = render(
      <>
        <Button type="button">Primary</Button>
        <Button type="button" variant="secondary">
          Secondary
        </Button>
        <Button type="button" disabled>
          Disabled
        </Button>
        <Button type="button" loading>
          Saving…
        </Button>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
