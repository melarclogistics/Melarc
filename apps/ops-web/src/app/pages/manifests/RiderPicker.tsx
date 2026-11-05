import { useState } from 'react';

import { Picker, type PickerOption } from '../../../components/ui/picker/Picker';
import type { ReadQuery } from '../../../components/ui/read-state/ReadState';
import type { RiderView } from '../../../platform/rider/rider-shape';
import { useRiders } from '../../../platform/rider/use-rider-queries';

/** What an officer is told of a rider when choosing one: the facts the roster returns, as facts, never as a judgement of fitness. */
export function riderOption(rider: RiderView): PickerOption {
  const readiness = [
    rider.pin_established ? undefined : 'no PIN set',
    rider.has_active_device ? undefined : 'no registered device',
  ].filter((part): part is string => part !== undefined);
  return {
    value: rider.id,
    label: rider.full_name,
    description: readiness.length === 0 ? rider.phone : `${rider.phone} · ${readiness.join(', ')}`,
  };
}

export interface RiderPickerProps {
  /** What is being chosen, as the group's legend: "Rider". */
  readonly label: string;
  /** The hub whose riders are offered: the manifest's. What the officer's grant reaches is not who may be given the run. */
  readonly hubId: string;
  readonly value: PickerOption | null;
  readonly onChange: (option: PickerOption | null) => void;
  /** What is wrong with the choice: nothing is chosen, or the server refused it. It goes on the search field. */
  readonly error?: string;
  readonly disabled?: boolean;
  /** The words of the button that chooses a result: "Choose". */
  readonly chooseAction?: string;
  /** The words of the button that sets the choice aside. */
  readonly changeAction?: string;
}

/**
 * The rider picker (S1.25; COMPONENT_PATTERNS section 22h): the searchable `Picker` over the riders the server lists
 * (`listRiders`, `dispatch.read`) **who are active and belong to the manifest's hub**, asked for as filters of the read and not worked out here.
 * The list opens at once, with every such rider the first page holds, so that an officer chooses from what there is and does not have to guess a
 * name; typing narrows it by name or phone, as the server matches them. More riders than the page returned are told as a reason to narrow the
 * search, never shown as the whole. Each rider is told by the facts the roster returns (name, phone, whether a PIN is set and a device is
 * registered) and nothing of their work; whether the server will accept the choice is its own answer (`RIDER_UNAVAILABLE`).
 */
export function RiderPicker({
  label,
  hubId,
  value,
  onChange,
  error,
  disabled = false,
  chooseAction = 'Choose',
  changeAction = 'Choose another rider',
}: RiderPickerProps) {
  const [search, setSearch] = useState('');
  const roster = useRiders({ status: 'ACTIVE', hubId, q: search, enabled: value === null });
  const results: ReadQuery<readonly PickerOption[]> = {
    status: roster.status,
    data: roster.data?.items.map(riderOption),
    error: roster.error,
    refetch: roster.refetch,
    isFetching: roster.isFetching,
  };
  const more = roster.data !== undefined && roster.data.nextPageToken !== null;

  return (
    <Picker
      label={label}
      required
      searchLabel="Search riders by name or phone"
      searchHelp="Leave it empty to list the active riders of this hub."
      searchAction="Search"
      onSearch={setSearch}
      results={results}
      noResults={
        <p>
          {search === ''
            ? 'No active rider of this hub is listed.'
            : 'No active rider of this hub matches. Try another name or number.'}
        </p>
      }
      moreResults={more}
      value={value}
      onChange={onChange}
      chooseAction={chooseAction}
      changeAction={changeAction}
      disabled={disabled}
      operation="listRiders"
      context="rider-picker"
      permission="dispatch.read"
      {...(error === undefined ? {} : { error })}
    />
  );
}
