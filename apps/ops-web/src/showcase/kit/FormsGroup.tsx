import { useState } from 'react';

import { DatePicker } from '../../components/ui/date-picker/DatePicker';
import { Field } from '../../components/ui/field/Field';
import { KitSection, Specimen } from './Section';

const nothing = (): void => undefined;

/** The date field in each state a page gives it (COMPONENT_PATTERNS section 22a). The page holds the date as text, and the specimen shows it. */
export function FormsGroup() {
  const [date, setDate] = useState<string | null>(null);
  const [range, setRange] = useState<string | null>('2026-11-12');
  return (
    <KitSection
      title="DateField"
      note="One field for DD/MM/YYYY and a calendar. Type the digits (the slashes are put in), step a part with the up and down arrows, or choose a day. Only a whole, real date is given to the page, and nothing is corrected for you: a day the month does not have (30 February) and a year in fewer than four digits are refused in words. Monday is the first day, and today is the day in Accra."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Empty, required">
          <Field label="Service date" help="Day, month and year." required>
            <DatePicker value={date} onChange={setDate} />
          </Field>
          <p>The page holds: {date ?? 'no date'}</p>
        </Specimen>
        <Specimen label="With a range: only 9 to 21 November 2026 are offered (a typed date outside is still given)">
          <Field label="Collection day" help="The calendar offers 9 to 21 November.">
            <DatePicker
              value={range}
              onChange={setRange}
              minValue="2026-11-09"
              maxValue="2026-11-21"
            />
          </Field>
          <p>The page holds: {range ?? 'no date'}</p>
        </Specimen>
        <Specimen label="With the page's own error">
          <Field
            label="Service date"
            error="Pickups run from Monday to Saturday. Choose another date."
          >
            <DatePicker value="2026-11-08" onChange={nothing} />
          </Field>
        </Specimen>
        <Specimen label="Read-only">
          <Field label="Booked for">
            <DatePicker value="2026-11-09" onChange={nothing} isReadOnly />
          </Field>
        </Specimen>
        <Specimen label="Disabled">
          <Field label="Rescheduled to">
            <DatePicker value="2026-11-09" onChange={nothing} isDisabled />
          </Field>
        </Specimen>
        <Specimen label="Standing on its own, named by aria-label">
          <DatePicker value={null} onChange={nothing} aria-label="Reschedule to" />
        </Specimen>
      </div>
    </KitSection>
  );
}
