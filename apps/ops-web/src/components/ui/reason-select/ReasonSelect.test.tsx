import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useReasonDefinitions,
  type ReasonBranch,
  type ReasonChoice,
  type ReasonOperation,
} from '../../../platform/reasons/reason-definitions';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderWithProviders } from '../../../test-support/render-providers';
import { wcagViolations } from '../../../test-support/wcag';
import { ReasonSelect } from './ReasonSelect';

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const LIST = '/reason-definitions';

interface PickerProps {
  readonly operation?: ReasonOperation;
  readonly branch?: ReasonBranch;
  readonly error?: string;
  readonly onChange?: (code: string, reason: ReasonChoice | undefined) => void;
}

function Picker({ operation = 'resetStaffMfa', branch, error, onChange }: PickerProps) {
  const query = useReasonDefinitions(operation, branch);
  const [value, setValue] = useState('');
  return (
    <ReasonSelect
      query={query}
      value={value}
      {...(error === undefined ? {} : { error })}
      onChange={(code, reason) => {
        setValue(code);
        onChange?.(code, reason);
      }}
    />
  );
}

const catalogue = () => [
  reasonFixture({ code: 'DEMO_ONE', label: 'Demo reason one' }),
  reasonFixture({ code: 'DEMO_TWO', label: 'Demo reason two', requiresNote: true }),
  reasonFixture({ code: 'DEMO_OLD', label: 'A retired reason', active: false }),
];

describe('ReasonSelect: what it asks the server', () => {
  // Break caught: the whole catalogue fetched and filtered on the screen. The filters are the server's, so the picker offers only
  // reasons the operation will not refuse as REASON_NOT_ACTIVE (listReasonDefinitions).
  it('asks for the reasons of one operation and branch, and for nothing else', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    renderWithProviders(<Picker operation="resetStaffMfa" branch="FACTOR_ACTIVE" />);

    await screen.findByRole('combobox', { name: /Reason/ });

    const url = new URL(api.requests[0]?.url ?? '');
    expect([...url.searchParams.entries()]).toEqual([
      ['operation', 'resetStaffMfa'],
      ['branch', 'FACTOR_ACTIVE'],
    ]);
  });

  it('sends no branch when the action has none', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    renderWithProviders(<Picker operation="revokeSession" />);

    await screen.findByRole('combobox', { name: /Reason/ });

    expect(new URL(api.requests[0]?.url ?? '').searchParams.has('branch')).toBe(false);
    expect(new URL(api.requests[0]?.url ?? '').searchParams.get('operation')).toBe('revokeSession');
  });

  // Break caught: a read that is repeated whenever the window is focused. Every request the API accepts counts as activity, so a
  // catalogue that polls keeps a session alive that nobody is using.
  it('does not read again when the window is focused or the connection returns', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    renderWithProviders(<Picker />);
    await screen.findByRole('combobox', { name: /Reason/ });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(api.requests).toHaveLength(1);
  });
});

describe('ReasonSelect: choosing', () => {
  it('offers a first option that is not a reason, then the active reasons in the server’s order', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    renderWithProviders(<Picker />);

    const select = await screen.findByRole('combobox', { name: 'Reason (required)' });

    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a reason', 'Demo reason one', 'Demo reason two']);
    expect(select).toHaveValue('');
  });

  it('says which reason was chosen, and whether it needs a note', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Picker onChange={onChange} />);
    const select = await screen.findByRole('combobox', { name: 'Reason (required)' });

    await user.selectOptions(select, 'DEMO_TWO');

    expect(onChange).toHaveBeenLastCalledWith('DEMO_TWO', {
      code: 'DEMO_TWO',
      label: 'Demo reason two',
      requiresNote: true,
    });
    await user.selectOptions(select, '');
    expect(onChange).toHaveBeenLastCalledWith('', undefined);
  });

  it('shows the error the form gave it, on the field', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    renderWithProviders(<Picker error="Choose a reason." />);

    const select = await screen.findByRole('combobox', { name: 'Reason (required)' });

    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAccessibleDescription('Choose a reason.');
  });

  // Break caught: a reason's label taken for markup. A label is the server's text.
  it('shows a label as text, whatever it holds', async () => {
    const hostile = '<img src=x onerror="document.title=1">Eve';
    api.on(`GET ${LIST}`, () => json(200, [reasonFixture({ code: 'DEMO_X', label: hostile })]));
    const { container } = renderWithProviders(<Picker />);

    await screen.findByRole('combobox', { name: 'Reason (required)' });

    expect(screen.getByRole('option', { name: hostile })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('ReasonSelect: when the reasons cannot be had', () => {
  it('says it is loading, and shows no control, until the reasons arrive', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on(`GET ${LIST}`, async () => {
      await held;
      return json(200, catalogue());
    });
    renderWithProviders(<Picker />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading the reasons…');
    expect(screen.queryByRole('combobox')).toBeNull();

    await act(async () => {
      release();
      await held;
    });
    expect(await screen.findByRole('combobox', { name: 'Reason (required)' })).toBeVisible();
  });

  // Break caught: a refusal that names no permission, or a role. The reason catalogue is read with settings.reason.read.
  it('names settings.reason.read when the session lacks it, and shows no control', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(403, 'PERMISSION_DENIED'));
    renderWithProviders(<Picker />);

    expect(await screen.findByText('settings.reason.read')).toBeVisible();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers a retry for a fault, and offers the reasons when the retry works', async () => {
    let answers = 0;
    api.on(`GET ${LIST}`, () => {
      answers += 1;
      return answers === 1 ? errorResponse(503, 'SETTING_MISSING') : json(200, catalogue());
    });
    const { user } = renderWithProviders(<Picker />);

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('combobox', { name: 'Reason (required)' })).toBeVisible();
    expect(answers).toBe(2);
  });

  // Break caught: a form that can be submitted with nothing to choose. The picker says there is no reason, and the form's own
  // confirm is not offered (ReasonConfirmationDialog).
  it('says so when no reason is available for the action', async () => {
    api.on(`GET ${LIST}`, () => json(200, []));
    renderWithProviders(<Picker />);

    expect(
      await screen.findByText('No reason is available for this action, so it cannot be done now.'),
    ).toBeVisible();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says so when every reason offered is retired', async () => {
    api.on(`GET ${LIST}`, () => json(200, [reasonFixture({ active: false })]));
    renderWithProviders(<Picker />);

    expect(
      await screen.findByText('No reason is available for this action, so it cannot be done now.'),
    ).toBeVisible();
  });

  // Break caught: an answer that is not the catalogue being offered as one.
  it.each([
    ['an object', { items: [] }],
    ['a list of strings', ['DEMO_ONE']],
  ])(
    'treats %s as an answer that is not the API’s: an error with a retry',
    async (_label, body) => {
      api.on(`GET ${LIST}`, () => json(200, body));
      renderWithProviders(<Picker />);

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
      expect(screen.queryByRole('combobox')).toBeNull();
    },
  );

  it('shows no error for a session that has ended: the boundary ends it and the guard takes the person away', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(401, 'SESSION_INVALID'));
    const { ended } = renderWithProviders(<Picker />, { signedIn: true });

    await waitFor(() => {
      expect(ended).toEqual(['SESSION_INVALID']);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/SESSION_|could not be loaded|try again/i);
  });
});

describe('ReasonSelect: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    api.on(`GET ${LIST}`, () => json(200, catalogue()));
    const { container } = renderWithProviders(<Picker error="Choose a reason." />);
    await screen.findByRole('combobox', { name: 'Reason (required)' });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
