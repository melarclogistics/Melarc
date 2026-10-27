import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConfirmedCommand } from '../../../platform/api/use-confirmed-command';
import type { Problem } from '../../../platform/problem/problem-copy';
import { CommandOutcomeNotice } from './command-outcome';

/**
 * What a command that is under way, refused, in conflict or of unknown outcome says (COMPONENT_PATTERNS sections 20.4 and 33.2). The
 * dialogs and the pages that send a command without one share it, so that they cannot disagree about the words of an outcome nobody knows.
 */
type Outcome = Parameters<typeof CommandOutcomeNotice>[0]['command'];

const command = (overrides: Partial<Outcome> = {}): Outcome => ({
  phase: 'idle',
  problem: undefined,
  canRetry: false,
  locked: false,
  retry: vi.fn<ConfirmedCommand<object>['retry']>(),
  checkRecord: vi.fn(),
  ...overrides,
});

const problem = (overrides: Partial<Problem> = {}): Problem => ({
  kind: 'refused',
  message: 'The request was refused in approved words.',
  ...overrides,
});

describe('CommandOutcomeNotice: an outcome nobody knows', () => {
  it('says the generic sentence, with the way out that fits whether the act can be sent again', () => {
    const { rerender } = render(
      <CommandOutcomeNotice command={command({ phase: 'unknown', canRetry: true })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not confirm whether this was done. You can try again: if it was already done, it is not done twice. Or check the record first.',
    );

    rerender(<CommandOutcomeNotice command={command({ phase: 'unknown', canRetry: false })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not confirm whether this was done. Check the record before doing anything else.',
    );
  });

  // Break caught: an act with words of its own for a code that may or may not have been made, told in the generic ones.
  it('says the words of the act instead, when it has some, whichever way out it offers', () => {
    const { rerender } = render(
      <CommandOutcomeNotice
        command={command({ phase: 'unknown', canRetry: true })}
        unknownText="We could not confirm whether the code was made."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not confirm whether the code was made.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/whether this was done/);

    rerender(
      <CommandOutcomeNotice
        command={command({ phase: 'unknown', canRetry: false })}
        unknownText="We could not confirm whether the code was made."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not confirm whether the code was made.',
    );
  });

  // Break caught: the refusal of a retry (which says why the second try did not go) dropped when the act has words of its own.
  it('shows what refused a retry beneath the words, the act’s own or the generic', () => {
    render(
      <CommandOutcomeNotice
        command={command({
          phase: 'unknown',
          canRetry: true,
          problem: problem({ message: 'The retry was refused.' }),
        })}
        unknownText="The act’s own words."
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The act’s own words.');
    expect(screen.getByRole('alert')).toHaveTextContent('The retry was refused.');
  });

  it('is announced, and is one alert', () => {
    render(
      <CommandOutcomeNotice command={command({ phase: 'unknown' })} unknownText="Own words." />,
    );

    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('CommandOutcomeNotice: a refusal and a conflict', () => {
  it.each(['refused', 'conflict'] as const)(
    'says %s in approved words, with the reference',
    (phase) => {
      render(
        <CommandOutcomeNotice
          command={command({ phase, problem: problem({ reference: 'req-42' }) })}
          unknownText="Own words."
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        'The request was refused in approved words.',
      );
      expect(screen.getByRole('alert')).toHaveTextContent('Reference: req-42');
      // The words for an outcome nobody knows are for that outcome only.
      expect(screen.getByRole('alert')).not.toHaveTextContent('Own words.');
    },
  );

  it('says nothing for a refusal that has no problem to state', () => {
    render(<CommandOutcomeNotice command={command({ phase: 'refused' })} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('CommandOutcomeNotice: a command that is idle, on its way or done', () => {
  it.each(['idle', 'sending', 'done'] as const)('says nothing while it is %s', (phase) => {
    render(<CommandOutcomeNotice command={command({ phase })} unknownText="Own words." />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).toBe('');
  });
});
