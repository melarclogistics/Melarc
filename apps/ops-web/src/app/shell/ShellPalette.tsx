import { useState } from 'react';
import { useNavigate } from 'react-router';

import {
  CommandPalette,
  type PaletteLink,
  type PaletteRecords,
} from '../../components/ui/app-shell/CommandPalette';
import {
  useRecordLookup,
  lookupTextFit,
  LOOKUP_MAX_CHARACTERS,
  type RecordLookupState,
} from '../../platform/lookup/use-record-lookup';
import { recordRoute } from '../../platform/lookup/record-route';
import { problemOf } from '../../platform/problem/problem-copy';
import { RATE_LIMITED_MESSAGE } from '../../platform/problem/rate-limit';
import { useReadHeld } from '../../platform/query/read-hold';
import type { Navigation } from '../navigation/navigation-model';
import { RECORD_ICONS, recordLine } from './record-line';

/** What a typed text finds among the pages: every word of it is in the page's name or in what the page is for, in any case. */
function matches(page: PaletteLink, text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  const haystack = `${page.label} ${page.keywords ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * What the search of records is in, in the terms the palette tells it (`useRecordLookup`'s states, and the words of a failure from the portal's
 * own table: the server's `message` is never shown). A failure that is a refusal of the session or an answer for a session that has gone shows
 * nothing, because the shell has taken the person away. **Nothing is tried again by itself**: the only way to ask again is the button.
 */
function recordsOf(lookup: RecordLookupState, typed: string, held: boolean): PaletteRecords {
  switch (lookup.status) {
    case 'idle':
      return { state: 'hint' };
    case 'waiting':
      // The session has asked too often and its automatic reads are held (`read-hold.ts`): the typed search is sent once, at the end of the wait.
      return held ? { state: 'slow', message: RATE_LIMITED_MESSAGE } : { state: 'loading' };
    case 'loading':
      return { state: 'loading' };
    case 'error': {
      const problem = problemOf(lookup.error, { operation: 'lookupRecords' });
      if (problem.kind === 'session-ended' || problem.kind === 'stale') return { state: 'hint' };
      // A 429 is the shared calm message in the status line, not an alert; asking again by hand is never held.
      if (problem.kind === 'rate-limited') {
        return { state: 'slow', message: problem.message, onRetry: lookup.retry };
      }
      return { state: 'error', message: problem.message, onRetry: lookup.retry };
    }
    case 'success': {
      const items = lookup.results.flatMap((result) => {
        // The page that opens a record is this application's own (`recordRoute`); a result that has none is not offered.
        const to = recordRoute(result.kind, result.id);
        return to === undefined
          ? []
          : [
              {
                id: `${result.kind}:${result.id}`,
                to,
                title: result.title,
                isCode: result.code !== null && result.code === result.title,
                subtitle: recordLine(result),
                icon: RECORD_ICONS[result.kind],
              },
            ];
      });
      return items.length === 0
        ? { state: 'empty', text: lookup.query || typed.trim() }
        : { state: 'results', items };
    }
  }
}

/**
 * The palette of the shell (surfaces/ops-portal.md section 4): the pages the session may open, the actions of the New menu, and the search of
 * `lookupRecords`, drawn by `CommandPalette`. It asks the server only while it is open and only for a text of two characters or more, and forgets
 * what was typed when it closes. Choosing a page or a record closes it and goes there, by the portal's own route.
 */
export function ShellPalette({
  open,
  onOpenChange,
  onCloseAutoFocus,
  navigation,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
  readonly navigation: Navigation;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // What was typed is forgotten when the palette closes: the next opening starts empty, and a search is never made for a closed palette.
  if (!open && query !== '') setQuery('');
  const lookup = useRecordLookup(open ? query : '');
  // Whether the session's automatic reads are held after a 429 (`read-hold.ts`): a search that is waiting then says so, calmly.
  const held = useReadHeld();

  const asLink = (entry: Navigation['create'][number]): PaletteLink => ({
    to: entry.to,
    label: entry.label,
    icon: entry.icon,
    ...(entry.description === undefined ? {} : { keywords: entry.description }),
  });
  const typed = query.trim();
  const fit = lookupTextFit(typed);
  const pages = [...navigation.groups.flatMap((group) => group.entries), ...navigation.account].map(
    asLink,
  );
  const actions = navigation.create.map(asLink);
  const narrow = (list: readonly PaletteLink[]) =>
    typed === '' ? list : list.filter((page) => matches(page, typed));

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      goTo={narrow(pages)}
      create={narrow(actions)}
      records={
        fit === 'too-short'
          ? { state: 'hint' }
          : fit === 'too-long'
            ? { state: 'too-long', limit: LOOKUP_MAX_CHARACTERS }
            : recordsOf(lookup, typed, held)
      }
      onSelect={(to) => {
        onOpenChange(false);
        void navigate(to);
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}
