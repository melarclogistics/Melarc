import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { EvidenceUpload } from './EvidenceUpload';
import { UploadGateNotice, useUploadGate } from './UploadGate';

/**
 * The gate of a form on its uploads (COMPONENT_PATTERNS, *EvidenceUpload*): a form that sends what it attaches must not send while a photo is still on its way, and **a person who is made to wait is told so, in words, naming
 * what they wait for**. A submit that is disabled with no reason beside it, above all for an upload that sits in a part of the form that is shut or scrolled away, is a form that does nothing and says nothing.
 */
const photo = (): File => new File([new Uint8Array(2048)], 'image.jpg', { type: 'image/jpeg' });

interface Pending {
  readonly resolve: (id: string) => void;
  readonly reject: (error: unknown) => void;
}

function Form({ pending }: { readonly pending: Pending[] }) {
  const gate = useUploadGate();
  const upload = () =>
    new Promise<string>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return (
    <form>
      {/* A part of the form that is shut: nothing in it can be seen. */}
      <details>
        <summary>Photos of the label</summary>
        <EvidenceUpload
          label="Photos of the label"
          upload={upload}
          failureText={() => 'The photo could not be sent.'}
          onChange={() => undefined}
          onBusyChange={gate.watch('Photos of the label')}
        />
      </details>
      <EvidenceUpload
        label="Photos of the damage"
        upload={upload}
        failureText={() => 'The photo could not be sent.'}
        onChange={() => undefined}
        onBusyChange={gate.watch('Photos of the damage')}
      />
      <UploadGateNotice gate={gate} id="upload-gate" />
      <button type="submit" disabled={gate.busy} aria-describedby="upload-gate">
        Send the count
      </button>
    </form>
  );
}

const setup = () => {
  const pending: Pending[] = [];
  const view = render(<Form pending={pending} />);
  return { ...view, pending, user: userEvent.setup() };
};
const choose = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.upload(screen.getByLabelText(label), photo());
};
const notice = (): HTMLElement => {
  const found = document.getElementById('upload-gate');
  if (found === null) throw new Error('no notice');
  return found;
};

describe('the upload gate of a form', () => {
  // Break caught: a form that waits for nothing, or one that says something while all is well (noise beside a submit that is free).
  it('says nothing and leaves the submit free while no photo is on its way', () => {
    setup();

    expect(notice()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Send the count' })).toBeEnabled();
  });

  // Break caught: a submit that waits and does not say for what (a button that is dead and a person who does not know why).
  it('names the upload that is on its way in words, and the submit waits and is described by them', async () => {
    const { user } = setup();

    await choose(user, 'Photos of the damage');

    expect(notice()).toHaveTextContent(
      'Photos of the damage is still being sent. Wait until it says Stored, then send.',
    );
    const submit = screen.getByRole('button', { name: 'Send the count' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      'Photos of the damage is still being sent. Wait until it says Stored, then send.',
    );
  });

  // Break caught: an upload in a part of the form that is shut blocking the submit with no word of it, which is the one that cannot be found.
  it('names an upload in a part of the form that is shut, which nobody can see', async () => {
    const { user } = setup();
    const details = document.querySelector('details');
    expect(details).not.toHaveAttribute('open');

    await choose(user, 'Photos of the label');

    expect(screen.getByLabelText('Photos of the label')).not.toBeVisible();
    expect(notice()).toHaveTextContent(
      'Photos of the label is still being sent. Wait until it says Stored, then send.',
    );
    expect(screen.getByRole('button', { name: 'Send the count' })).toBeDisabled();
  });

  // Break caught: only one of two uploads named, or both said as one, or the words left in the singular.
  it('names every upload that is on its way, in the order they began, and says them in the plural', async () => {
    const { user } = setup();

    await choose(user, 'Photos of the label');
    await choose(user, 'Photos of the damage');

    expect(notice()).toHaveTextContent(
      'Photos of the label and Photos of the damage are still being sent. Wait until they say Stored, then send.',
    );
  });

  // Break caught: a gate that stays shut once the photo is stored, or that is freed by the first of two uploads while the second is still on its way.
  it('is freed when the last upload is stored, and not before', async () => {
    const { user, pending } = setup();
    await choose(user, 'Photos of the label');
    await choose(user, 'Photos of the damage');

    await act(async () => {
      pending[0]?.resolve('0c1d2e3f-4a5b-4c6d-8e7f-000000000001');
      await Promise.resolve();
    });
    expect(notice()).toHaveTextContent('Photos of the damage is still being sent.');
    expect(screen.getByRole('button', { name: 'Send the count' })).toBeDisabled();

    await act(async () => {
      pending[1]?.resolve('0c1d2e3f-4a5b-4c6d-8e7f-000000000002');
      await Promise.resolve();
    });
    expect(notice()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Send the count' })).toBeEnabled();
  });

  // Break caught: a photo that failed keeping the form shut for ever (the field says it was not sent and offers to try again; it is not on its way).
  it('is freed when an upload fails, the field saying so', async () => {
    const { user, pending } = setup();
    await choose(user, 'Photos of the damage');

    await act(async () => {
      pending[0]?.reject(new Error('refused'));
      await Promise.resolve();
    });

    expect(notice()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Send the count' })).toBeEnabled();
    expect(await screen.findByText('The photo could not be sent.')).toBeVisible();
  });

  // Break caught: a notice that is added to the page with its words in it (a region that appears with its text is not announced reliably): it is a polite status in the page first.
  it('is a polite status region that is in the page before it has anything to say', async () => {
    const { user } = setup();
    const region = notice();
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // It is in the accessibility tree while it is empty (a hidden region is not announced when it is shown), not only in the markup.
    expect(screen.getAllByRole('status')).toContain(region);

    await choose(user, 'Photos of the damage');

    expect(notice()).toBe(region);
  });

  it('has no accessibility violations while an upload is on its way', async () => {
    const { user, container } = setup();
    await choose(user, 'Photos of the damage');

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('useUploadGate', () => {
  // Break caught: a callback made anew at every render, which makes a field that is given it tell the page again and again.
  it('gives the same callback for the same name, so that a field is not told again for nothing', () => {
    const { result, rerender } = renderHook(() => useUploadGate());
    const first = result.current.watch('Photos of the damage');

    rerender();

    expect(result.current.watch('Photos of the damage')).toBe(first);
    expect(result.current.watch('Photos of the label')).not.toBe(first);
  });

  // Break caught: three uploads said as two (the middle one lost between the first and the last), which a form of two uploads cannot show.
  it('names three uploads with commas and an "and", in the plural', () => {
    const { result } = renderHook(() => useUploadGate());

    act(() => {
      result.current.watch('Photos of the label')(true);
      result.current.watch('Photos of the damage')(true);
      result.current.watch('Photos of the seal')(true);
    });

    expect(result.current.words).toBe(
      'Photos of the label, Photos of the damage and Photos of the seal are still being sent. Wait until they say Stored, then send.',
    );
  });

  // Break caught: a name told busy twice listed twice, or one told free that was never busy making a hole.
  it('lists a name once however often it is told busy, and drops it when told free', () => {
    const { result } = renderHook(() => useUploadGate());

    act(() => {
      result.current.watch('A')(true);
      result.current.watch('A')(true);
      result.current.watch('B')(true);
    });
    expect(result.current.pending).toEqual(['A', 'B']);
    expect(result.current.busy).toBe(true);

    act(() => {
      result.current.watch('C')(false);
      result.current.watch('A')(false);
    });
    expect(result.current.pending).toEqual(['B']);

    act(() => {
      result.current.watch('B')(false);
    });
    expect(result.current.pending).toEqual([]);
    expect(result.current.busy).toBe(false);
    expect(result.current.words).toBeUndefined();
  });
});
