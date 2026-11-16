import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { EvidenceUpload, PREVIEW_PIXELS, type EvidenceUploadProps } from './EvidenceUpload';

/**
 * The evidence upload in its photo mode (COMPONENT_PATTERNS, *EvidenceUpload*, the hub floor): a phone or a tablet in a stockroom takes the photos with its camera. **Two buttons the size of the hub floor**,
 * "Take a photo" (the rear camera: `capture="environment"`) and "Choose from the gallery" (no capture); **images only, never a document**; each photo is **shown back to the person** (a preview drawn on a
 * canvas from the file, **never from a URL**: the portal's policy, `img-src 'self'`, refuses a `blob:` picture) and named by its **place**, not by the file name a camera gives every photo; and **a photo can be
 * retaken**, which replaces that photo and stops the one it replaces. The sending, the words of a failure and the identifiers handed to the page are those of the file mode.
 */
const ID_ONE = '0c1d2e3f-4a5b-4c6d-8e7f-000000000001';
const ID_TWO = '0c1d2e3f-4a5b-4c6d-8e7f-000000000002';

const photo = (name = 'image.jpg', size = 2048): File =>
  new File([new Uint8Array(size)], name, { type: 'image/jpeg' });

interface Pending {
  readonly file: File;
  readonly signal: AbortSignal;
  readonly resolve: (id: string) => void;
  readonly reject: (error: unknown) => void;
}

/** A bitmap as the browser gives one: its size, and the way to let go of it. */
interface FakeBitmap {
  readonly width: number;
  readonly height: number;
  readonly close: ReturnType<typeof vi.fn>;
}

let decoded: { readonly file: Blob; readonly options: unknown; readonly bitmap: FakeBitmap }[] = [];
let drawn: unknown[][] = [];
let objectUrls = 0;
// What the environment has of the way to decode a photo (nothing, in jsdom), put back after each test: the tests below replace it with their own. The canvas and the object URL are spied on and restored.
const nativeBitmap = globalThis.createImageBitmap;

/** A decoding that answers at once with a bitmap of the size given: 4 x 3 (a landscape photo) unless it is told otherwise. */
function decodesAtOnce(width = 4, height = 3): void {
  globalThis.createImageBitmap = ((file: Blob, options?: unknown) => {
    const bitmap: FakeBitmap = { width, height, close: vi.fn() };
    decoded.push({ file, options, bitmap });
    return Promise.resolve(bitmap as unknown as ImageBitmap);
  }) as typeof createImageBitmap;
}

beforeEach(() => {
  decoded = [];
  drawn = [];
  objectUrls = 0;
  decodesAtOnce();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    drawImage: (...args: unknown[]) => {
      drawn.push(args);
    },
  })) as never);
  // Never called: a picture made from an object URL is refused by the portal's policy. If it were, the real one would be asked to read a file it cannot.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    objectUrls += 1;
    return 'blob:never';
  });
});
afterEach(() => {
  globalThis.createImageBitmap = nativeBitmap;
  vi.restoreAllMocks();
});

/** The row of the photo at a place, counting from 0. */
const rowAt = (at: number): HTMLElement => {
  const row = screen.getAllByRole('listitem')[at];
  if (row === undefined) throw new Error(`There is no photo at place ${String(at)}.`);
  return row;
};

/** What a test waits for after a photo is taken: the decoding of it, which is a promise. */
const decoding = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

function photos(overrides: Partial<EvidenceUploadProps> = {}) {
  const pending: Pending[] = [];
  const onChange = vi.fn<(stored: readonly string[]) => void>();
  const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
  const ui = (more: Partial<EvidenceUploadProps> = {}) => (
    <EvidenceUpload
      mode="photos"
      label="Photos of the damage"
      help="Take a photo of each damaged parcel."
      accept="image/jpeg,application/pdf"
      upload={(file, _report, signal) =>
        new Promise<string>((resolve, reject) => {
          pending.push({ file, signal, resolve, reject });
        })
      }
      failureText={() => 'The photo could not be sent.'}
      onChange={onChange}
      {...overrides}
      {...more}
    />
  );
  const view = render(ui());
  const camera = (): HTMLInputElement => {
    const found = view.container.querySelector<HTMLInputElement>('input[capture]');
    if (found === null) throw new Error('no camera input');
    return found;
  };
  const gallery = (): HTMLInputElement => {
    const found = view.container.querySelector<HTMLInputElement>(
      'input[type="file"]:not([capture])',
    );
    if (found === null) throw new Error('no gallery input');
    return found;
  };
  const take = (...files: File[]): void => {
    act(() => {
      fireEvent.change(camera(), { target: { files } });
    });
  };
  const choose = (...files: File[]): void => {
    act(() => {
      fireEvent.change(gallery(), { target: { files } });
    });
  };
  return {
    ...view,
    ui,
    pending,
    onChange,
    clicked,
    camera,
    gallery,
    take,
    choose,
    user: userEvent.setup(),
  };
}

describe('EvidenceUpload: the photo mode’s two ways in', () => {
  // Break caught: the two ways of adding a photo drawn at the medium size, or as links, or without their words: a thumb's miss, a button that does nothing, an icon that is the only thing it says.
  it('offers a camera and a gallery as two buttons the size of the hub floor, in a group named by the page', () => {
    photos();

    const group = screen.getByRole('group', { name: 'Photos of the damage' });
    expect(group).toHaveAccessibleDescription('Take a photo of each damaged parcel.');
    for (const name of ['Take a photo', 'Choose from the gallery']) {
      const button = within(group).getByRole('button', { name });
      expect(button).toHaveClass('ui-button--lg');
      expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // Break caught: a camera that opens the front camera or the file chooser of the old kind, a gallery that opens the camera, a document taken in this mode, or one photo a time from the gallery.
  it('asks the camera at the back for one photo, and the gallery for several, and both for images and never a document', () => {
    const { camera, gallery } = photos();

    expect(camera()).toHaveAttribute('capture', 'environment');
    expect(camera()).toHaveAttribute('accept', 'image/*');
    expect(camera().multiple).toBe(false);
    expect(gallery()).not.toHaveAttribute('capture');
    expect(gallery()).toHaveAttribute('accept', 'image/*');
    expect(gallery().multiple).toBe(true);
    // The page's own `accept` (it may name a document for the file mode) is not what this mode asks for.
    expect(camera().accept).not.toMatch(/pdf/);
    expect(gallery().accept).not.toMatch(/pdf/);
  });

  // Break caught: each button opening the other's chooser, or neither.
  it('opens the camera for the first button and the gallery for the second', async () => {
    const { user, clicked, camera, gallery } = photos();

    await user.click(screen.getByRole('button', { name: 'Take a photo' }));
    await user.click(screen.getByRole('button', { name: 'Choose from the gallery' }));

    expect(clicked.mock.contexts).toEqual([camera(), gallery()]);
  });

  // Break caught: a way in that stays live when the page said the field is off.
  it('offers neither way in when it is disabled', () => {
    photos({ disabled: true });

    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose from the gallery' })).toBeDisabled();
  });

  // Break caught: a way in that is not in the order of the page for a person at the keyboard, or one that cannot be reached.
  it('is reached by the keyboard: the camera, the gallery, then each photo’s own buttons', async () => {
    const { user, take } = photos();
    take(photo());

    await user.tab();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Choose from the gallery' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Retake photo 1' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Leave out photo 1' })).toHaveFocus();
  });
});

describe('EvidenceUpload: the photos taken', () => {
  // Break caught: a photo that is not sent when it is taken, or two photos of one name (a camera calls every photo the same) that cannot be told apart, for a person or for a screen reader.
  it('sends each photo as soon as it is taken, and names it by its place', () => {
    const { take, choose, pending } = photos();

    take(photo('image.jpg'));
    choose(photo('image.jpg'), photo('image.jpg'));

    expect(pending).toHaveLength(3);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rowAt(0)).getByText(/^Photo 1/)).toBeVisible();
    expect(within(rowAt(2)).getByText(/^Photo 3/)).toBeVisible();
    expect(screen.queryByText(/image\.jpg/)).toBeNull();
    expect(screen.getByRole('list', { name: 'Photos of the damage: photos added' })).toBeVisible();
  });

  // Break caught: a photo that is not shown back to the person who took it (they cannot tell a good one from a blurred one), a preview drawn from a URL (the portal's policy refuses it), or one read as well as named.
  it('shows each photo back as a square on a canvas drawn from its file, and never from a URL', async () => {
    const { take, choose, container } = photos();
    const first = photo();
    const second = photo();

    take(first);
    choose(second);
    await decoding();

    expect(decoded.map((entry) => entry.file)).toEqual([first, second]);
    const canvases = [...container.querySelectorAll('canvas')];
    expect(canvases).toHaveLength(2);
    for (const canvas of canvases) {
      expect(canvas).toHaveAttribute('aria-hidden', 'true');
      expect(canvas.width).toBe(PREVIEW_PIXELS);
      expect(canvas.height).toBe(PREVIEW_PIXELS);
    }
    expect(container.querySelector('img')).toBeNull();
    expect(objectUrls).toBe(0);
  });

  // Break caught: a photo of twelve million pixels decoded whole to draw eighty, or one that is squashed into a square, or drawn from its corner.
  it('decodes at the size of the preview and draws the middle square of the photo', async () => {
    const { take } = photos();

    take(photo());
    await decoding();

    expect(decoded[0]?.options).toEqual({ resizeWidth: PREVIEW_PIXELS * 2 });
    // A 4 by 3 bitmap: the square is 3 by 3, a half a pixel in from the left.
    expect(drawn).toEqual([
      [decoded[0]?.bitmap, 0.5, 0, 3, 3, 0, 0, PREVIEW_PIXELS, PREVIEW_PIXELS],
    ]);
  });

  // Break caught: the middle taken from one side only (a portrait photo, which is how a person holds a phone, cropped from its top).
  it('draws the middle square of a portrait photo too', async () => {
    decodesAtOnce(3, 4);
    const { take } = photos();

    take(photo());
    await decoding();

    expect(drawn).toEqual([
      [decoded[0]?.bitmap, 0, 0.5, 3, 3, 0, 0, PREVIEW_PIXELS, PREVIEW_PIXELS],
    ]);
  });

  // Break caught: a bitmap kept after it was drawn (a photo held in memory for as long as the page is open, sixty of them in a stockroom).
  it('lets go of each bitmap as soon as it is drawn', async () => {
    const { take, choose } = photos();

    take(photo());
    choose(photo());
    await decoding();

    expect(decoded.map((entry) => entry.bitmap.close.mock.calls.length)).toEqual([1, 1]);
  });

  // Break caught: a photo that is left out while it is being decoded, drawn on a canvas that is gone, or its bitmap never let go of.
  it('lets go of a bitmap that arrives after its photo was left out, and draws nothing', async () => {
    let arrive: (bitmap: ImageBitmap) => void = () => undefined;
    const late: FakeBitmap = { width: 4, height: 3, close: vi.fn() };
    globalThis.createImageBitmap = () =>
      new Promise<ImageBitmap>((resolve) => {
        arrive = resolve;
      });
    const { take, user } = photos();
    take(photo());

    await user.click(screen.getByRole('button', { name: 'Leave out photo 1' }));
    await act(async () => {
      arrive(late as unknown as ImageBitmap);
      await Promise.resolve();
    });

    expect(drawn).toEqual([]);
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  // Break caught: a file that is not an image given a preview (a document drawn as a broken picture).
  it('makes no preview of a file that is not an image', async () => {
    const { choose, container } = photos();

    choose(new File([new Uint8Array(10)], 'note.pdf', { type: 'application/pdf' }));
    await decoding();

    expect(decoded).toEqual([]);
    expect(container.querySelector('canvas')).toBeNull();
  });

  // Break caught: a browser that cannot decode a photo to a bitmap breaking the field instead of showing no preview.
  it('works without a preview where the browser cannot decode a photo', () => {
    globalThis.createImageBitmap = undefined as unknown as typeof createImageBitmap;
    const { take, container } = photos();

    take(photo());

    expect(screen.getByRole('listitem')).toHaveTextContent('Photo 1');
    expect(container.querySelector('canvas')).toBeNull();
  });

  // Break caught: a photo that cannot be decoded (a format the browser does not know) failing the field, or an error left unhandled.
  it('works, with nothing drawn, when a photo cannot be decoded', async () => {
    globalThis.createImageBitmap = () => Promise.reject(new Error('not an image'));
    const { take } = photos();

    take(photo());
    await decoding();

    expect(screen.getByRole('listitem')).toHaveTextContent('Photo 1');
    expect(drawn).toEqual([]);
  });

  // Break caught: a canvas that cannot be drawn on (no 2d context) throwing, or its bitmap never let go of.
  it('lets go of the bitmap and works when there is nothing to draw on', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const { take } = photos();

    take(photo());
    await decoding();

    expect(decoded[0]?.bitmap.close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('listitem')).toHaveTextContent('Photo 1');
  });

  // Break caught: the file mode drawing a preview of every file, which holds a decoded photo for a list that shows a name and a size.
  it('draws no preview in the file mode', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EvidenceUpload
        label="Photos of what you found"
        upload={() => new Promise<string>(() => undefined)}
        failureText={() => 'The photo could not be sent.'}
        onChange={() => undefined}
      />,
    );

    await user.upload(screen.getByLabelText('Photos of what you found'), photo());
    await decoding();

    expect(decoded).toEqual([]);
    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.getByRole('listitem')).toHaveTextContent('image.jpg');
  });

  // Break caught: a failure that is told in words the page did not choose, or a photo that cannot be sent again by its place.
  it('tells a failure in the page’s words and sends the photo again, by its place', async () => {
    const { take, pending, user } = photos();
    take(photo());

    await act(async () => {
      pending[0]?.reject(new Error('refused'));
      await Promise.resolve();
    });
    expect(await screen.findByText('The photo could not be sent.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try photo 1 again' }));

    expect(pending).toHaveLength(2);
  });

  // Break caught: the identifiers of the stored photos not handed to the page, in the order the photos were taken.
  it('hands the page the identifiers of the stored photos, in the order they were taken', async () => {
    const { take, pending, onChange } = photos();
    take(photo());
    take(photo());

    await act(async () => {
      pending[1]?.resolve(ID_TWO);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith([ID_TWO]);
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenLastCalledWith([ID_ONE, ID_TWO]);
  });
});

describe('EvidenceUpload: retaking a photo', () => {
  // Break caught: a retake that adds a photo instead of replacing one (the blurred photo is still evidence and the page cites it), or that leaves the first still on its way.
  it('replaces that photo in its place and stops the one it replaces', async () => {
    const { take, pending, user, container } = photos();
    take(photo('a.jpg'));
    take(photo('b.jpg'));
    const second = photo('c.jpg');

    await user.click(screen.getByRole('button', { name: 'Retake photo 1' }));
    take(second);
    await decoding();

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(pending).toHaveLength(3);
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(pending[1]?.signal.aborted).toBe(false);
    expect(pending[2]?.file).toBe(second);
    // The new photo has the old one's place, and the preview that is drawn is the new one's.
    expect(within(rowAt(0)).getByText(/^Photo 1/)).toBeVisible();
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
    expect(decoded.at(-1)?.file).toBe(second);
  });

  // Break caught: a retaken photo that is handed to the page beside the one it replaced (a stored photo that was replaced is no longer the person's evidence).
  it('hands the page the replacement and not the photo it replaced', async () => {
    const { take, pending, onChange, user } = photos();
    take(photo());
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith([ID_ONE]);

    await user.click(screen.getByRole('button', { name: 'Retake photo 1' }));
    take(photo());

    expect(onChange).toHaveBeenLastCalledWith([]);
    await act(async () => {
      pending[1]?.resolve(ID_TWO);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith([ID_TWO]);
  });

  // Break caught: a retake that is used for every photo the camera brings after it, so that the second photo of a stockroom replaces the first again.
  it('is used once: the next photo the camera brings is a new one', async () => {
    const { take, pending, user } = photos();
    take(photo());
    await user.click(screen.getByRole('button', { name: 'Retake photo 1' }));
    take(photo());

    take(photo());

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(pending).toHaveLength(3);
    expect(pending[1]?.signal.aborted).toBe(false);
  });

  // Break caught: a retake that the person gave up (the camera was closed) that makes the next photo they take replace the one they meant to keep.
  it('is given up when the person goes on to take another photo', async () => {
    const { take, pending, user } = photos();
    take(photo());

    await user.click(screen.getByRole('button', { name: 'Retake photo 1' }));
    await user.click(screen.getByRole('button', { name: 'Take a photo' }));
    take(photo());

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(pending[0]?.signal.aborted).toBe(false);
  });

  // Break caught: a retake that opens the gallery, or no chooser at all.
  it('opens the camera', async () => {
    const { take, user, clicked, camera } = photos();
    take(photo());
    clicked.mockClear();

    await user.click(screen.getByRole('button', { name: 'Retake photo 1' }));

    expect(clicked.mock.contexts).toEqual([camera()]);
  });

  // Break caught: a retake that is cancelled (no photo comes back) that changes the photo.
  it('changes nothing when the camera brings no photo back', async () => {
    const { take, user, pending } = photos();
    take(photo());

    await user.click(screen.getByRole('button', { name: 'Retake photo 1' }));
    take();

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(pending[0]?.signal.aborted).toBe(false);
  });

  // Break caught: a field that the page switched off (it is sending its act) that still takes a new photo in place of one it holds.
  it('offers no retake once the field is disabled', () => {
    const { take, rerender, ui } = photos();
    take(photo());
    expect(screen.getByRole('button', { name: 'Retake photo 1' })).toBeEnabled();

    rerender(ui({ disabled: true }));

    expect(screen.getByRole('button', { name: 'Retake photo 1' })).toBeDisabled();
  });
});

describe('EvidenceUpload: the photo mode for a person who cannot see it', () => {
  // Break caught: a place that is a file name again in what is announced, or a result said for a photo the person cannot identify.
  it('says a photo’s outcome by its place, once, in one polite region', async () => {
    const { take, pending } = photos();
    take(photo('image.jpg'));

    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      await Promise.resolve();
    });

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Photo 1: stored.');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  // Break caught: a violation of its own in either mode of the field: a group without a name, a preview read as an image, a button with only an icon.
  it('has no accessibility violations with a photo in each state', async () => {
    const { take, choose, pending, container } = photos();
    take(photo());
    choose(photo());
    take(photo());
    await act(async () => {
      pending[0]?.resolve(ID_ONE);
      pending[1]?.reject(new Error('refused'));
      await Promise.resolve();
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
