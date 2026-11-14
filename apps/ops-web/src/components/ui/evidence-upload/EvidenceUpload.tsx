import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import { Button } from '../button/Button';
import { Field, useFieldControl } from '../field/Field';
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
  /** What the file chooser offers, as the `accept` of a file input (`image/jpeg,image/png,application/pdf`): a hint to the chooser and nothing more, the platform judges every file. */
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
  /** Whether a file is on its way: the page keeps its submit from going while one is, so that nothing it was told to attach is left out. */
  readonly onBusyChange?: (busy: boolean) => void;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/**
 * The evidence photo upload (COMPONENT_PATTERNS, *EvidenceUpload*): the files a person adds as evidence of an act, each **sent as soon as it is chosen** and told per file: on its way, stored or not sent,
 * with a way to try a file again and a way to leave it out. **It is generic and decides no policy**: it knows no operation, no owner and no limit, is given one function that sends a file and one that words
 * a failure, and draws the file's name and size and the page's words and nothing else: **never a storage key, an upload address or the identifier of a record**. What it hands the page is the identifiers
 * of the stored files, in the order they were added, which the page cites when it sends its act. It is a native file input, so it is operable from the keyboard as the browser's own is, and its states
 * are told in words beside a badge and once, politely, in one live region.
 */
export function EvidenceUpload({
  label,
  help,
  error,
  required = false,
  accept,
  disabled = false,
  upload,
  failureText,
  onChange,
  onBusyChange,
}: EvidenceUploadProps) {
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const next = useRef(0);
  const controllers = useRef(new Map<number, AbortController>());
  const latest = useRef({ upload, failureText, onChange, onBusyChange });
  useEffect(() => {
    latest.current = { upload, failureText, onChange, onBusyChange };
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
        setAnnouncement(`${file.name}: stored.`);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const text = latest.current.failureText(failure);
        change(key, { status: 'failed', error: text, step: '' });
        setAnnouncement(`${file.name}: not sent. ${text}`);
      })
      .finally(() => {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
      });
  }

  function add(files: readonly File[]): void {
    const added = files.map((file): FileEntry => {
      next.current += 1;
      return {
        key: next.current,
        file,
        status: 'sending',
        step: '',
        id: undefined,
        error: undefined,
      };
    });
    setEntries((current) => [...current, ...added]);
    for (const entry of added) send(entry.key, entry.file);
  }

  function remove(key: number): void {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setEntries((current) => current.filter((entry) => entry.key !== key));
  }

  return (
    <div className="ui-evidence-upload">
      <Field
        label={label}
        required={required}
        {...(help === undefined ? {} : { help })}
        {...(error === undefined ? {} : { error })}
      >
        <Control accept={accept} disabled={disabled} onChoose={add} />
      </Field>
      {entries.length === 0 ? null : (
        <ul className="ui-evidence-upload__list" aria-label={`${label}: files added`}>
          {entries.map((entry) => (
            <li key={entry.key} className="ui-evidence-upload__file">
              <p className="ui-evidence-upload__name">
                {entry.file.name}{' '}
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
                    aria-label={`Try ${entry.file.name} again`}
                    onClick={() => {
                      send(entry.key, entry.file);
                    }}
                  >
                    Try again
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Leave out ${entry.file.name}`}
                  onClick={() => {
                    remove(entry.key);
                  }}
                >
                  Leave out
                </Button>
              </p>
            </li>
          ))}
        </ul>
      )}
      {/* One polite region for the whole list: a file's outcome is said once, when it comes. */}
      <div role="status" aria-live="polite">
        <VisuallyHidden>{announcement}</VisuallyHidden>
      </div>
    </div>
  );
}
