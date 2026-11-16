import { useCallback, useRef, useState } from 'react';

import './evidence-upload.css';

export interface UploadGate {
  /** The names of the uploads that are on their way now, in the order they began. */
  readonly pending: readonly string[];
  /** Whether any upload is on its way: what a submit waits on. */
  readonly busy: boolean;
  /** What the submit says while it waits, naming what it waits for; `undefined` when nothing is on its way. */
  readonly words: string | undefined;
  /** The `onBusyChange` of the upload called `name` (its label). The same function for the same name, so that an upload that is given it is not told again for nothing. */
  readonly watch: (name: string) => (busy: boolean) => void;
}

function wordsOf(names: readonly string[]): string | undefined {
  const [first] = names;
  if (first === undefined) return undefined;
  if (names.length === 1) {
    return `${first} is still being sent. Wait until it says Stored, then send.`;
  }
  const last = names.at(-1) ?? '';
  return `${names.slice(0, -1).join(', ')} and ${last} are still being sent. Wait until they say Stored, then send.`;
}

/**
 * The gate of a form on its uploads (COMPONENT_PATTERNS, *EvidenceUpload*): a form that sends what it attaches must not send while a photo is on its way, and **a person who is made to wait is told so, in
 * words, naming what they wait for**: the submit is disabled while `busy`, and `UploadGateNotice` says why beside it. An upload in a part of the form that is shut or scrolled away is named too, because the gate is
 * told by the upload itself and not by what can be seen: a submit that does nothing and says nothing is the one thing the person cannot find the cause of.
 */
export function useUploadGate(): UploadGate {
  const [pending, setPending] = useState<readonly string[]>([]);
  const watchers = useRef(new Map<string, (busy: boolean) => void>());
  const watch = useCallback((name: string) => {
    let watcher = watchers.current.get(name);
    if (watcher === undefined) {
      watcher = (busy: boolean) => {
        setPending((current) => {
          if (busy) return current.includes(name) ? current : [...current, name];
          return current.filter((other) => other !== name);
        });
      };
      watchers.current.set(name, watcher);
    }
    return watcher;
  }, []);
  return { pending, busy: pending.length > 0, words: wordsOf(pending), watch };
}

/**
 * The words of the gate, beside the submit: **a polite status region that is in the page before it has anything to say** (a region that is added with its words in it is not announced reliably), so that the
 * person is told when they must wait and when they need not. Give it an `id` and let the submit name it in `aria-describedby`, so that the submit itself says why it waits.
 */
export function UploadGateNotice({
  gate,
  id,
}: {
  readonly gate: UploadGate;
  readonly id?: string;
}) {
  return (
    <div
      className="ui-evidence-upload__gate"
      role="status"
      aria-live="polite"
      {...(id === undefined ? {} : { id })}
    >
      {gate.words === undefined ? null : <p>{gate.words}</p>}
    </div>
  );
}
