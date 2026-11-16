import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, type FakeApi } from '../../../test-support/fake-api';
import {
  arrivedParcel,
  extraParcel,
  parcelFixture,
  photoLinkHandlers,
} from '../../../test-support/receiving-fixture';
import { renderWithProviders } from '../../../test-support/render-providers';
import { parseParcel } from '../../../platform/hub-receiving/receiving-shape';
import { ParcelGrid, tileOf } from './ParcelGrid';

/**
 * The parcels of a vendor as a grid of tiles (D-D1, D-D2): **what a tile says is the API's state of its parcel**, in words (the icon never alone), a tile is a toggle only while the officer is checking parcels
 * in, a parcel taken back cannot be checked in again, and a press is told to the page, which acts on it. The grid draws pictures only for the photos it is given the link of.
 */
let api: FakeApi | undefined;
afterEach(() => {
  expect(api?.unhandled ?? []).toEqual([]);
  api?.restore();
  api = undefined;
});

const parcel = (raw: ReturnType<typeof parcelFixture>) => {
  const parsed = parseParcel(raw);
  if (parsed === undefined) throw new Error('the parcel of the test is not one');
  return parsed;
};

const damaged = parcel(
  arrivedParcel(2, {
    condition: {
      condition: 'DAMAGED',
      note: 'A torn corner',
      evidence_ids: ['9f0a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b'],
      recorded_by_name: 'Ama Owusu',
      recorded_at: '2026-11-16T09:15:00Z',
    },
  }),
);

describe('what a tile says of its parcel', () => {
  // Break caught: a state said by an icon and no words, or a parcel that was not checked in said to be.
  it.each([
    [parcel(parcelFixture(1)), false, { kind: 'normal' }],
    [parcel(arrivedParcel(1)), false, { kind: 'selected', label: 'Checked in' }],
    [parcel(arrivedParcel(1)), true, { kind: 'selected', label: 'Checked in' }],
    [
      parcel(parcelFixture(1, { state: 'MISSING', missing_marked_at: '2026-11-16T09:20:00Z' })),
      false,
      { kind: 'marked', label: 'Missing' },
    ],
    [parcel(extraParcel(4, { state: 'VOID' })), false, { kind: 'dimmed', label: 'Taken back' }],
  ])('is as the state says: %#', (given, tapping, expected) => {
    expect(tileOf(given, tapping)).toEqual(expected);
  });

  // Break caught: a damaged parcel drawn as an ordinary one that is checked in, or, while the officer is tapping, as one that is not on.
  it('marks a damaged parcel as damaged, and keeps it on while the officer is tapping', () => {
    expect(tileOf(damaged, false)).toEqual({ kind: 'marked', label: 'Damaged' });
    expect(tileOf(damaged, true)).toEqual({ kind: 'selected', label: 'Checked in, damaged' });
  });
});

describe('the grid of a vendor’s parcels', () => {
  const parcels = [
    parcel(arrivedParcel(1)),
    parcel(parcelFixture(2)),
    parcel(extraParcel(3)),
    parcel(extraParcel(4, { state: 'VOID' })),
  ];

  function open(props: Partial<Parameters<typeof ParcelGrid>[0]> = {}) {
    api = installFakeApi(photoLinkHandlers(parcels));
    return renderWithProviders(
      <ParcelGrid label="Photos of Kente Crafts’s parcels" parcels={parcels} {...props} />,
      { signedIn: true },
    );
  }

  it('names each tile by its parcel and its state, the extras apart, and shows each place', async () => {
    open();
    const list = await screen.findByRole('list', { name: 'Photos of Kente Crafts’s parcels' });
    expect(list).toBeVisible();
    expect(screen.getByRole('button', { name: 'Parcel 1, Checked in' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Parcel 2' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Extra parcel 3, Checked in' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Extra parcel 4, Taken back' })).toBeVisible();
    await waitFor(() => {
      // The pictures are decorative (the tile is named by the grid): an image with no text alternative has no role to ask for.
      expect(document.querySelectorAll('img')).toHaveLength(4);
    });
  });

  // Break caught: tiles that look like toggles when the officer is only looking (a tap that checks a parcel in by accident), or that do not say whether they are on while the officer is tapping.
  it('is a row of toggles only while the officer is tapping', async () => {
    const view = open();
    await screen.findByRole('list');
    for (const tile of screen.getAllByRole('button'))
      expect(tile).not.toHaveAttribute('aria-pressed');
    view.unmount();
    api?.restore();

    open({ tapping: true });
    await screen.findByRole('list');
    expect(screen.getByRole('button', { name: 'Parcel 1, Checked in' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Parcel 2' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  // Break caught: a parcel that was taken back offered as a toggle, so that a tap seems to bring it back when the API will refuse it.
  it('does not let the officer tap a parcel that was taken back while they are tapping', async () => {
    open({ tapping: true });
    await screen.findByRole('list');
    expect(screen.getByRole('button', { name: 'Extra parcel 4, Taken back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Parcel 2' })).toBeEnabled();
  });

  it('tells the page which parcel was pressed and decides nothing itself', async () => {
    const onPress = vi.fn();
    open({ tapping: true, onPress });
    await screen.findByRole('list');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Parcel 2' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0]?.[0]).toMatchObject({ ordinal: 2, state: 'EXPECTED' });
  });
});
