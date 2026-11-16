import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import { Button } from '../button/Button';
import { Field, useFieldControl } from '../field/Field';
import { Icon } from '../icon/Icon';
import { StatusBadge, type StatusMap } from '../status-badge/StatusBadge';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import './evidence-upload.css';

/**
 * Where one file is: on its way (`sending`, with the step the page reported), stored on the platform (`stored`, with the identifier it was given), or failed (`failed`, with the page's words). */
type FileStatus = 'sending' | 'stored' | 'failed';

interface FileEntry {
  readonly key: number;
  readonly file: File;
  readonly status: FileStatus;
  /** What the page said the file is doing, in its words: told while it is sending. */
  readonly step: string;
  /** The identifier of the stored record: held by this entry and cited by the page, **never drawn**. */
  readonly id: string | undefined;
  /** What the page said of the failure, in its words. */
  readonly error: string | undefined;
}

const STATUS_MAP: StatusMap<FileStatus> = {
  sending: { tone: 'info', label: 'Sending' },
  stored: { tone: 'success', label: 'Stored' },
  failed: { tone: 'danger', label: 'Not sent' },
};

export interface EvidenceUploadProps {
  /** What the files are, in a few words ("Photos of what you found"). It is the field's label. */
  readonly label: string;
  /** What to add and what is accepted, in a line. */
  readonly help?: string;
  /** What is wrong and how to put it right: its presence makes the field invalid. */
  readonly error?: string;
  readonly required?: boolean;
  /**
   * `files` (the default): one native file input that takes several files of the types `accept` names.
   * `photos` (a phone or a tablet at the hub floor): two buttons the size of the hub floor, "Take a photo" (the camera at the back) and "Choose from the gallery", that take **images and never a document**
   * (`accept` is not used); each photo is shown back as a preview, named by its place ("Photo 2") and can be retaken.
   */
  readonly mode?: 'files' | 'photos';
  /** What the file chooser offers, as the `accept` of a file input (`image/jpeg,image/png,application/pdf`): a hint to the chooser and nothing more, the platform judges every file. Not used in the photo mode. */
  readonly accept?: string;
  readonly disabled?: boolean;
  /**
   * Sends one file and answers with the identifier of the stored record, or throws. **It is the page's**: the component knows no API, no address and no policy, and is never given an upload
   * address or a storage key. `report` tells where the file is, in words the page chooses; `signal` is aborted when the file is removed or the component goes.
   */
  readonly upload: (
    file: File,
    report: (step: string) => void,
    signal: AbortSignal,
  ) => Promise<string>;
  /** What a failure says, in the page's words: the component draws nothing the API said. */
  readonly failureText: (error: unknown) => string;
  /** The files that are stored, as the identifiers `upload` answered with, in the order they were added. Told when the set changes. */
  readonly onChange: (stored: readonly string[]) => void;
  /** Whether a file is on its way: the page keeps its submit from going while one is, so that nothing it was told to attach is left out (`useUploadGate` says so in words beside the submit). */
  readonly onBusyChange?: (busy: boolean) => void;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The side of a preview in pixels, twice what the stylesheet draws it at (5rem), so that it is sharp on a screen of twice the density. */
export const PREVIEW_PIXELS = 160;

/** Whether a photo can be shown back: the browser can decode a file to a bitmap, and the file is an image. */
function canPreview(file: File): boolean {
  return typeof createImageBitmap === 'function' && file.type.startsWith('image/');
}

/**
 * A preview of a photo, **drawn on a canvas from the file, never from a URL**. A picture made from an object URL (`blob:`) or a data URL is refused by the portal's own policy, `img-src 'self'`
 * (architecture/SECURITY_DESIGN.md section 14.8: nothing else is allowed, and the evidence store's origin is the one thing that is, by configuration), and a preview that the browser blocked would be
 * a broken picture beside every photo a person takes. The file is decoded to a bitmap at a size of the preview's own (a camera's photo is twelve million pixels, and none of them is wanted here), the middle square of it is
 * drawn, and **the bitmap is closed at once**: the canvas holds a small square and the photo is held by nothing but the file. A photo that cannot be decoded has no preview and the field works as it did.
 */
function Preview({ file }: { readonly file: File }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let gone = false;
    createImageBitmap(file, { resizeWidth: PREVIEW_PIXELS * 2 })
      .then((bitmap) => {
        const context = gone ? null : canvas.current?.getContext('2d');
        if (context !== null && context !== undefined) {
          const side = Math.min(bitmap.width, bitmap.height);
          context.drawImage(
            bitmap,
            (bitmap.width - side) / 2,
            (bitmap.height - side) / 2,
            side,
            side,
            0,
            0,
            PREVIEW_PIXELS,
            PREVIEW_PIXELS,
          );
        }
        // Whether it was drawn or not (the photo was left out while it was being decoded), the bitmap is let go of now.
        bitmap.close();
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [file]);
  return (
    <canvas
      ref={canvas}
      className="ui-evidence-upload__preview"
      width={PREVIEW_PIXELS}
      height={PREVIEW_PIXELS}
      aria-hidden="true"
    />
  );
}

function Control({
  accept,
  disabled,
  onChoose,
}: {
  readonly accept: string | undefined;
  readonly disabled: boolean;
  readonly onChoose: (files: readonly File[]) => void;
}) {
  const field = useFieldControl();
  function chosen(event: ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    // The same file can be chosen again after it was removed: the input holds nothing once the page has the files.
    event.target.value = '';
    if (files.length > 0) onChoose(files);
  }
  return (
    <input
      type="file"
      multiple
      className="ui-evidence-upload__input"
      {...(field === null
        ? {}
        : {
            id: field.id,
            'aria-describedby': field.describedBy,
            'aria-invalid': field.invalid ? true : undefined,
          })}
      {...(accept === undefined ? {} : { accept })}
      disabled={disabled}
      onChange={chosen}
    />
  );
}

/** The two ways into the photo mode, in a group the field names: the buttons open the choosers, which are hidden inputs of the component. */
function Sources({
  disabled,
  onCamera,
  onGallery,
}: {
  readonly disabled: boolean;
  readonly onCamera: () => void;
  readonly onGallery: () => void;
}) {
  const field = useFieldControl();
  return (
    <div
      role="group"
      className="ui-evidence-upload__sources"
      {...(field === null
        ? {}
        : {
            id: field.id,
            'aria-labelledby': field.labelId,
            'aria-describedby': field.describedBy,
          })}
    >
      <Button type="button" variant="secondary" size="lg" disabled={disabled} onClick={onCamera}>
        <Icon name="camera" />
        Take a photo
      </Button>
      <Button type="button" variant="secondary" size="lg" disabled={disabled} onClick={onGallery}>
        <Icon name="gallery" />
        Choose from the gallery
      </Button>
    </div>
  );
}

/**
 * The evidence photo upload (COMPONENT_PATTERNS, *EvidenceUpload*): the files a person adds as evidence of an act, each **sent as soon as it is chosen** and told per file: on its way, stored or not sent,
 * with a way to try a file again and a way to leave it out. **It is generic and decides no policy**: it knows no operation, no owner and no limit, is given one function that sends a file and one that words
 * a failure, and draws the file's name and size and the page's words and nothing else: **never a storage key, an upload address or the identifier of a record**. What it hands the page is the identifiers
 * of the stored files, in the order they were added, which the page cites when it sends its act. It is a native file input, so it is operable from the keyboard as the browser's own is, and its states
 * are told in words beside a badge and once, politely, in one live region.
 *
 * **The photo mode** (`mode="photos"`, the hub floor): "Take a photo" asks for the camera at the back (`capture="environment"`, one photo) and "Choose from the gallery" for images (several), two buttons the size of
 * the hub floor, **for images and never a document**. Each photo is **shown back** (a preview drawn on a canvas from the file, never from an object URL: the portal's policy refuses a `blob:` picture), **named by its
 * place** ("Photo 2": a camera gives every photo the same file name) and **can be retaken**, which replaces that photo in its place and stops the one it replaces. A retake that the person gives up (they go on to
 * take another photo) changes nothing. **The buttons of a photo's row (Retake, Leave out, Try again) are the hub floor's 56 px too**, as every button of a hub-floor dialog is. The sending, the words of a failure and
 * what the page is handed are those of the file mode.
 */
export function EvidenceUpload({
  label,
  help,
  error,
  required = false,
  mode = 'files',
  accept,
  disabled = false,
  upload,
  failureText,
  onChange,
  onBusyChange,
}: EvidenceUploadProps) {
  const photos = mode === 'photos';
  /** The buttons of a file's row: the hub floor's 56 px in the photo mode, where every button is (a dialog of the floor has no button of 44 px), and the working height for files. */
  const rowSize = photos ? 'lg' : 'md';
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const next = useRef(0);
  const controllers = useRef(new Map<number, AbortController>());
  const latest = useRef({ upload, failureText, onChange, onBusyChange, entries, photos });
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  /** The photo that the camera's next photo replaces, once the person has asked to retake it. */
  const retaking = useRef<number | null>(null);
  useEffect(() => {
    latest.current = { upload, failureText, onChange, onBusyChange, entries, photos };
  });

  useEffect(() => {
    const open = controllers.current;
    return () => {
      for (const controller of open.values()) controller.abort();
      open.clear();
    };
  }, []);

  const storedKey = entries
    .filter((entry) => entry.status === 'stored')
    .map((entry) => entry.id)
    .join('|');
  const busy = entries.some((entry) => entry.status === 'sending');
  useEffect(() => {
    latest.current.onChange(
      entries.flatMap((entry) =>
        entry.status === 'stored' && entry.id !== undefined ? [entry.id] : [],
      ),
    );
    // Told when the set of stored files changes, and not for each render of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);
  useEffect(() => {
    latest.current.onBusyChange?.(busy);
  }, [busy]);

  function change(key: number, patch: Partial<FileEntry>): void {
    setEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }

  /** What a file is called where it is told: the photo mode names a photo by its place, the file mode by its name. */
  function titleOf(key: number, file: File): string {
    const index = latest.current.entries.findIndex((entry) => entry.key === key);
    return latest.current.photos && index !== -1 ? `Photo ${String(index + 1)}` : file.name;
  }

  function send(key: number, file: File): void {
    const controller = new AbortController();
    controllers.current.set(key, controller);
    change(key, { status: 'sending', step: '', error: undefined });
    latest.current
      .upload(
        file,
        (step) => {
          if (!controller.signal.aborted) change(key, { step });
        },
        controller.signal,
      )
      .then((id) => {
        if (controller.signal.aborted) return;
        change(key, { status: 'stored', id, step: '' });
        setAnnouncement(`${titleOf(key, file)}: stored.`);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const text = latest.current.failureText(failure);
        change(key, { status: 'failed', error: text, step: '' });
        setAnnouncement(`${titleOf(key, file)}: not sent. ${text}`);
      })
      .finally(() => {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
      });
  }

  function entryOf(file: File): FileEntry {
    next.current += 1;
    return {
      key: next.current,
      file,
      status: 'sending',
      step: '',
      id: undefined,
      error: undefined,
    };
  }

  function add(files: readonly File[]): void {
    const added = files.map(entryOf);
    setEntries((current) => [...current, ...added]);
    for (const entry of added) send(entry.key, entry.file);
  }

  /** A retaken photo takes the place of the one it replaces, which is stopped. */
  function replace(key: number, file: File): void {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    const entry = entryOf(file);
    setEntries((current) => current.map((other) => (other.key === key ? entry : other)));
    send(entry.key, entry.file);
  }

  function remove(key: number): void {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setEntries((current) => current.filter((entry) => entry.key !== key));
  }

  function fromCamera(event: ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    const [first] = files;
    if (first === undefined) return;
    const target = retaking.current;
    retaking.current = null;
    if (target === null) add(files);
    else replace(target, first);
  }

  function fromGallery(event: ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length > 0) add(files);
  }

  return (
    <div className="ui-evidence-upload">
      <Field
        label={label}
        required={required}
        {...(help === undefined ? {} : { help })}
        {...(error === undefined ? {} : { error })}
      >
        {photos ? (
          <Sources
            disabled={disabled}
            onCamera={() => {
              retaking.current = null;
              camera.current?.click();
            }}
            onGallery={() => {
              gallery.current?.click();
            }}
          />
        ) : (
          <Control accept={accept} disabled={disabled} onChoose={add} />
        )}
      </Field>
      {photos ? (
        <>
          {/* The choosers the two buttons open: images only, the camera at the back for one photo and the gallery for several. */}
          <input
            ref={camera}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            tabIndex={-1}
            onChange={fromCamera}
          />
          <input
            ref={gallery}
            type="file"
            accept="image/*"
            multiple
            hidden
            tabIndex={-1}
            onChange={fromGallery}
          />
        </>
      ) : null}
      {entries.length === 0 ? null : (
        <ul
          className="ui-evidence-upload__list"
          aria-label={`${label}: ${photos ? 'photos' : 'files'} added`}
        >
          {entries.map((entry, index) => {
            const title = photos ? `Photo ${String(index + 1)}` : entry.file.name;
            // What the buttons of the row name: "Retake photo 2" in a sentence, and a file's own name as it is.
            const named = photos ? lowerFirst(title) : title;
            return (
              <li
                key={entry.key}
                className={`ui-evidence-upload__file${photos ? ' ui-evidence-upload__file--photo' : ''}`}
              >
                {photos && canPreview(entry.file) ? <Preview file={entry.file} /> : null}
                <div className="ui-evidence-upload__details">
                  <p className="ui-evidence-upload__name">
                    {title}{' '}
                    <span className="ui-evidence-upload__size">({sizeText(entry.file.size)})</span>
                  </p>
                  <p className="ui-evidence-upload__state">
                    <StatusBadge status={entry.status} map={STATUS_MAP} />
                    {entry.status === 'sending' && entry.step !== '' ? (
                      <span className="ui-evidence-upload__step">{entry.step}</span>
                    ) : null}
                  </p>
                  {entry.status === 'failed' && entry.error !== undefined ? (
                    <p className="ui-evidence-upload__error">{entry.error}</p>
                  ) : null}
                  <p className="ui-evidence-upload__acts">
                    {entry.status === 'failed' ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size={rowSize}
                        aria-label={`Try ${named} again`}
                        onClick={() => {
                          send(entry.key, entry.file);
                        }}
                      >
                        Try again
                      </Button>
                    ) : null}
                    {photos ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size={rowSize}
                        disabled={disabled}
                        aria-label={`Retake ${named}`}
                        onClick={() => {
                          retaking.current = entry.key;
                          camera.current?.click();
                        }}
                      >
                        <Icon name="retake" />
                        Retake
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      size={rowSize}
                      aria-label={`Leave out ${named}`}
                      onClick={() => {
                        remove(entry.key);
                      }}
                    >
                      Leave out
                    </Button>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {/* One polite region for the whole list: a file's outcome is said once, when it comes. */}
      <div role="status" aria-live="polite">
        <VisuallyHidden>{announcement}</VisuallyHidden>
      </div>
    </div>
  );
}

/** "Photo 2" read in a sentence: "retake photo 2". A file's own name is left as it is. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
