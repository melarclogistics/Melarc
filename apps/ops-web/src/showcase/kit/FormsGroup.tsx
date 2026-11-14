import { useState } from 'react';

import { DatePicker } from '../../components/ui/date-picker/DatePicker';
import { EvidenceUpload } from '../../components/ui/evidence-upload/EvidenceUpload';
import { Field } from '../../components/ui/field/Field';
import { KitSection, Specimen } from './Section';

const nothing = (): void => undefined;

/** A store that is made up: it answers after a moment, and refuses a file whose name says "fail". The page of a real screen sends the file to the platform. */
function madeUpStore(
  file: File,
  report: (step: string) => void,
  signal: AbortSignal,
): Promise<string> {
  report('Sending the photo…');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (/fail/i.test(file.name)) reject(new Error('The store declined it.'));
      else resolve(`sample-${file.name}`);
    }, 600);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
}

/** The evidence upload in each state a page gives it (COMPONENT_PATTERNS, *EvidenceUpload*). Every file is made up and goes to no store. */
function EvidenceUploadSpecimens() {
  const [stored, setStored] = useState<readonly string[]>([]);
  return (
    <KitSection
      title="EvidenceUpload"
      note="The files a person adds as evidence, each sent as soon as it is chosen and told one by one: on its way, stored or not sent, with a way to try a file again and a way to leave it out. It knows no API, no address and no policy: the page gives it the function that sends a file and the words of a failure, and it hands the page the identifiers of the files that are stored. A file is never shown by an address or a key. These specimens send nothing: a file whose name has the word fail in it is refused, to show the failure."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Empty, optional">
          <EvidenceUpload
            label="Photos of what you found"
            help="Add a photo (JPEG or PNG) or a PDF. Each is sent as soon as you choose it."
            accept="image/jpeg,image/png,application/pdf"
            upload={madeUpStore}
            failureText={() => 'The photo could not be sent. Try again.'}
            onChange={setStored}
          />
          <p>
            The page holds {String(stored.length)} stored {stored.length === 1 ? 'file' : 'files'}.
          </p>
        </Specimen>
        <Specimen label="Required, with the page's own error">
          <EvidenceUpload
            label="Photos of what you found"
            required
            error="Add at least one photo of what you found."
            upload={madeUpStore}
            failureText={() => 'The photo could not be sent. Try again.'}
            onChange={nothing}
          />
        </Specimen>
        <Specimen label="Disabled">
          <EvidenceUpload
            label="Photos of what you found"
            disabled
            upload={madeUpStore}
            failureText={() => 'The photo could not be sent. Try again.'}
            onChange={nothing}
          />
        </Specimen>
      </div>
    </KitSection>
  );
}

/** The date field in each state a page gives it (COMPONENT_PATTERNS section 22a). The page holds the date as text, and the specimen shows it. */
export function FormsGroup() {
  const [date, setDate] = useState<string | null>(null);
  const [range, setRange] = useState<string | null>('2026-11-12');
  return (
    <>
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
      <EvidenceUploadSpecimens />
    </>
  );
}
