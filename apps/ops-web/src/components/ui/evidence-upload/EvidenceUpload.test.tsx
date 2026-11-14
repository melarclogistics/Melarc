import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { EvidenceUpload, type EvidenceUploadProps } from './EvidenceUpload';

const ID_ONE = '0c1d2e3f-4a5b-4c6d-8e7f-000000000001';
const ID_TWO = '0c1d2e3f-4a5b-4c6d-8e7f-000000000002';

const photo = (name: string, size = 2048): File =>
  new File([new Uint8Array(size)], name, { type: 'image/jpeg' });

interface Pending {
  readonly file: File;
  readonly report: (step: string) => void;
  readonly signal: AbortSignal;
  readonly resolve: (id: string) => void;
  readonly reject: (error: unknown) => void;
}

/** An upload the test settles by hand, so that each state of a file can be looked at while it lasts. */
function harness(overrides: Partial<EvidenceUploadProps> = {}) {
  const pending: Pending[] = [];
  const onChange = vi.fn<(stored: readonly string[]) => void>();
  const onBusyChange = vi.fn<(busy: boolean) => void>();
  const upload: EvidenceUploadProps['upload'] = (file, report, signal) =>
    new Promise<string>((resolve, reject) => {
      pending.push({ file, report, signal, resolve, reject });
    });
  const props: EvidenceUploadProps = {
    label: 'Photos of what you found',
    help: 'A photo or a PDF.',
    accept: 'image/jpeg,image/png,application/pdf',
    upload,
    failureText: () => 'The photo could not be sent.',
    onChange,
    onBusyChange,
    ...overrides,
  };
  const view = render(<EvidenceUpload {...props} />);
  const user = userEvent.setup();
  const input = screen.getByLabelText(/Photos of what you found/);
  return { ...view, pending, onChange, onBusyChange, user, input: input as HTMLInputElement };
}

describe('EvidenceUpload', () => {
  // Break caught: a file chooser that is not a file input, that does not take several files, or that does not offer the types the page said (a hint, and only that).
  it('is a native file input labelled by the page, with its help, that takes several files of the types given', () => {
    const { input } = harness();

    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('image/jpeg,image/png,application/pdf');
    expect(input).toHaveAccessibleDescription('A photo or a PDF.');
  });

  // Break caught: a file that is not sent when it is chosen, or that is sent with something other than the file itself and the means to stop it.
  it('sends each file as soon as it is chosen, and tells the file is on its way', async () => {
    const { user, input, pending } = harness();
    const file = photo('door.jpg');
    await user.upload(input, file);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.file).toBe(file);
    expect(pending[0]?.signal.aborted).toBe(false);
    const row = within(screen.getByRole('listitem'));
    expect(row.getByText(/door\.jpg/)).toBeVisible();
    expect(row.getByText('(2 KB)')).toBeVisible();
    expect(row.getByText('Sending')).toBeVisible();
  });

  // Break caught: the step the page reports not shown, so that a file that is being checked, prepared or confirmed looks the same as one that is stuck.
  it('shows the step the page reports while a file is on its way', async () => {
    const { user, input, pending } = harness();
    await user.upload(input, photo('door.jpg'));

    act(() => {
      pending[0]?.report('Checking the file…');
    });
    expect(screen.getByText('Checking the file…')).toBeVisible();
    act(() => {
      pending[0]?.report('Sending the photo…');
    });
    expect(screen.queryByText('Checking the file…')).toBeNull();
    expect(screen.getByText('Sending the photo…')).toBeVisible();
  });

  // Break caught: a stored file that is not handed to the page, handed over in another order than it was added, or one that is still on its way counted as stored.
  it('hands the page the identifiers of the stored files, in the order they were added, and only those', async () => {
    const { user, input, pending, onChange } = harness();
    await user.upload(input, [photo('one.jpg'), photo('two.jpg')]);
    expect(pending).toHaveLength(2);

    // The second finishes first: the order is the order of adding, and a file still on its way is not stored.
    await act(async () => {
      pending[1]?.resolve(ID_TWO);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([ID_TWO]);
    });
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([ID_ONE, ID_TWO]);
    });
    expect(screen.getAllByText('Stored')).toHaveLength(2);
  });

  // Break caught: the identifier of a stored record drawn on the screen, which is an internal name and tells a person nothing.
  it('never draws the identifier of a stored file', async () => {
    const { user, input, pending, container } = harness();
    await user.upload(input, photo('door.jpg'));
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    await screen.findByText('Stored');

    expect(container.textContent).not.toContain(ID_ONE);
    expect(container.innerHTML).not.toContain(ID_ONE);
  });

  // Break caught: a failure drawn in the API's words or the browser's, or a file that cannot be sent again, or one that is sent again as a second file.
  it('tells a failure in the page’s words, and sends the same file again when asked', async () => {
    const failureText = vi.fn(() => 'The photo could not be sent to the store. Try again.');
    const { user, input, pending, onChange } = harness({ failureText });
    const file = photo('door.jpg');
    await user.upload(input, file);

    await act(async () => {
      pending[0]?.reject(new Error('socket hang up at https://bucket.invalid/secret'));
      await Promise.resolve();
    });
    expect(await screen.findByText('Not sent')).toBeVisible();
    expect(screen.getByText('The photo could not be sent to the store. Try again.')).toBeVisible();
    expect(document.body.textContent).not.toContain('bucket.invalid');
    expect(failureText).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Try door.jpg again' }));
    expect(pending).toHaveLength(2);
    expect(pending[1]?.file).toBe(file);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Sending')).toBeVisible();

    await act(async () => {
      pending[1]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    expect(await screen.findByText('Stored')).toBeVisible();
    expect(onChange).toHaveBeenLastCalledWith([ID_ONE]);
  });

  // Break caught: a file left out that is still sent, still counted, or still told; and a stored one that stays in what the page cites.
  it('leaves a file out: it is stopped, forgotten, and no longer handed to the page', async () => {
    const { user, input, pending, onChange } = harness();
    await user.upload(input, [photo('one.jpg'), photo('two.jpg')]);
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([ID_ONE]);
    });

    await user.click(screen.getByRole('button', { name: 'Leave out two.jpg' }));
    expect(pending[1]?.signal.aborted).toBe(true);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Leave out one.jpg' }));
    expect(screen.queryByRole('listitem')).toBeNull();
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith([]);
    });

    // What a file that was left out answers afterwards is not told.
    await act(async () => {
      pending[1]?.resolve(ID_TWO);
      await Promise.resolve();
    });
    expect(screen.queryByText('Stored')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  // Break caught: a page left with files on their way and no way to know, so that it sends its act without the evidence it was told to attach.
  it('tells the page whether a file is on its way', async () => {
    const { user, input, pending, onBusyChange } = harness();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    await user.upload(input, photo('door.jpg'));
    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(true);
    });
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });
  });

  // Break caught: files still being sent after the component has gone, so that a late answer is told to a page that is not there.
  it('stops every file that is on its way when it goes', async () => {
    const { user, input, pending, unmount } = harness();
    await user.upload(input, photo('door.jpg'));
    expect(pending[0]?.signal.aborted).toBe(false);

    unmount();
    expect(pending[0]?.signal.aborted).toBe(true);
  });

  // Break caught: a field that is required and wrong without saying so, or that does not say what is wrong where the keyboard lands.
  it('is invalid, with its error told beside it, when the page says so', () => {
    const { input } = harness({ required: true, error: 'Add at least one photo.' });

    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(expect.stringContaining('Add at least one photo.'));
    expect(screen.getByText('(required)')).toBeVisible();
  });

  it('does not take a file when it is disabled', () => {
    const { input } = harness({ disabled: true });
    expect(input).toBeDisabled();
  });

  // Break caught: a control that cannot be reached by keyboard: the chooser, then each file's own controls, in order.
  it('is operable from the keyboard: the chooser, then try again and leave out of each file', async () => {
    const { user, input, pending } = harness();
    await user.upload(input, photo('door.jpg'));
    await act(async () => {
      pending[0]?.reject(new Error('x'));
      await Promise.resolve();
    });
    await screen.findByText('Not sent');

    input.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Try door.jpg again' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Leave out door.jpg' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  // Break caught: the outcome of a file said to a screen reader for each render, or not at all.
  it('says a file’s outcome once, in one polite region', async () => {
    const { user, input, pending } = harness();
    await user.upload(input, photo('door.jpg'));
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(region).toHaveTextContent('door.jpg: stored.');
    });
  });

  it('has no accessibility violations with a file in each state', async () => {
    const { user, input, pending, container } = harness({ required: true });
    await user.upload(input, [photo('one.jpg'), photo('two.jpg'), photo('three.jpg')]);
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      pending[1]?.reject(new Error('x'));
      await Promise.resolve();
    });
    await screen.findByText('Not sent');

    expect(await wcagViolations(container)).toEqual([]);
  });
});
