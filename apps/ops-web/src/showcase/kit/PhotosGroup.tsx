import { useState } from 'react';

// The sheet of the page's picture (`PhotoPicture`), which the sample of the viewer is drawn with, so that the viewer is measured against the same classes a receiving screen's photo has.
import '../../app/pages/evidence/photo-picture.css';
import { Button } from '../../components/ui/button/Button';
import { Checkbox } from '../../components/ui/checkbox/Checkbox';
import { ConnectionBanner } from '../../components/ui/connection-banner/ConnectionBanner';
import { EvidenceUpload } from '../../components/ui/evidence-upload/EvidenceUpload';
import { UploadGateNotice, useUploadGate } from '../../components/ui/evidence-upload/UploadGate';
import { Icon } from '../../components/ui/icon/Icon';
import { PhotoGrid, type PhotoGridItem } from '../../components/ui/photo-grid/PhotoGrid';
import { PhotoViewer, type PhotoViewerItem } from '../../components/ui/photo-viewer/PhotoViewer';
import { RadioGroup } from '../../components/ui/radio/RadioGroup';
import { ReadState, type ReadQuery } from '../../components/ui/read-state/ReadState';
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
    }, 1500);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
}

/** What stands for a photo on this page: a box with its number. No photo is read from any store here, and none is made up to look like a parcel. */
function SamplePicture({ label }: { readonly label: string }) {
  return <span className="showcase-photo-sample">{label}</span>;
}

/** A read that has finished: how the page's picture hands a photo that is ready to `ReadState` (`PhotoPicture`, size `full`). */
const READY: ReadQuery<true> = {
  status: 'success',
  data: true,
  error: undefined,
  refetch: () => Promise.resolve(),
  isFetching: false,
};

/**
 * What the page's picture draws in the viewer for a photo that is ready: an image in the read's own box, with the picture's own classes, so that the viewer is measured against what really made it overflow (a photo
 * has more pixels than any screen has room for, and is as tall as the screen allows and more) and against the box a receiving screen puts it in. **The image is a file of this site** (the brand's symbol): the strict
 * policy of the page refuses any other address, and no photo is read from a store or made up to look like a parcel. The symbol has no size of its own, so the size of a photo's pixels is given by the attributes.
 */
function SampleFullPicture({ label }: { readonly label: string }) {
  return (
    <ReadState query={READY} isEmpty={() => false} empty={null}>
      {() => (
        <img
          className="photo-picture photo-picture--full"
          src="/favicon.svg"
          alt={label}
          width={1600}
          height={1200}
          decoding="async"
        />
      )}
    </ReadState>
  );
}

const GRID_ITEMS: readonly PhotoGridItem[] = [
  { key: '1', label: 'Sample parcel 1' },
  { key: '2', label: 'Sample parcel 2', state: { kind: 'selected', label: 'Here' } },
  { key: '3', label: 'Sample parcel 3', state: { kind: 'marked', label: 'Missing' } },
  {
    key: '4',
    label: 'Sample parcel 4',
    state: { kind: 'dimmed', label: 'Not on the table' },
    badge: '4',
  },
  { key: '5', label: 'Sample parcel 5' },
  { key: '6', label: 'Sample parcel 6', badge: '6' },
  { key: '7', label: 'Sample parcel 7' },
];

const VIEWER_ITEMS: readonly PhotoViewerItem[] = [1, 2, 3, 4, 5].map((n) => ({
  key: String(n),
  label: `Sample photo ${String(n)}`,
  ...(n % 2 === 1 ? { detail: `Taken 12 November 2026, 10:4${String(n)}` } : {}),
}));

function PhotoGridSpecimens() {
  const [found, setFound] = useState<ReadonlySet<string>>(new Set(['2']));
  const [pressed, setPressed] = useState('Nothing yet');
  const tickable: readonly PhotoGridItem[] = GRID_ITEMS.slice(0, 5).map((item) => ({
    key: item.key,
    label: item.label,
    ...(found.has(item.key) ? { state: { kind: 'selected', label: 'Found' } as const } : {}),
  }));
  return (
    <KitSection
      title="PhotoGrid"
      note="The photos of a vendor, a parcel or a finding as tiles of one shape, three to a row on a phone and as many as fit on a desk. Each tile is a button of at least 56 px, the whole grid is one stop of the Tab key with the arrow keys moving between the tiles, and a tile says its state in an icon and words, never in colour alone. The grid decides nothing: the page draws each picture and says what a press means. The boxes below stand for photos (nothing is read from a store here)."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Normal, ticked, missing, set apart, with a badge" edge>
          <PhotoGrid
            label="Sample photos of one stop"
            items={GRID_ITEMS}
            renderPicture={(item) => (
              <SamplePicture label={item.label.replace('Sample parcel ', 'Sample ')} />
            )}
            onSelect={(item) => {
              setPressed(item.label);
            }}
          />
          <p className="showcase-kit-specimen__note">Last pressed: {pressed}</p>
        </Specimen>
        <Specimen label="Tiles that are ticked as found" edge>
          <PhotoGrid
            label="Sample photos to tick"
            items={tickable}
            selectable
            renderPicture={(item) => (
              <SamplePicture label={item.label.replace('Sample parcel ', 'Sample ')} />
            )}
            onSelect={(item) => {
              setFound((current) => {
                const next = new Set(current);
                if (next.has(item.key)) next.delete(item.key);
                else next.add(item.key);
                return next;
              });
            }}
          />
          <p className="showcase-kit-specimen__note">{String(found.size)} of 5 ticked as found.</p>
        </Specimen>
        <Specimen label="A picture that cannot be shown" width="14rem">
          <PhotoGrid
            label="Sample photo that is not available"
            items={[{ key: 'x', label: 'Sample parcel 8' }]}
            renderPicture={() => (
              <span className="showcase-photo-unavailable">
                <Icon name="photo-unavailable" />
                <span>Photo not available</span>
              </span>
            )}
          />
        </Specimen>
      </div>
    </KitSection>
  );
}

function PhotoViewerSpecimen() {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <KitSection
      title="PhotoViewer"
      note="One photo at a time over the dialog, among the others of its grid: where the person is (3 of 12), two buttons the size of the hub floor beside it, the arrow keys and a swipe of a finger, one neighbour loaded ahead, and Escape to close. The viewer is as tall as the screen allows and the photo takes the room that the controls leave, so that the buttons never leave the screen and do not move from one photo to the next. It decides nothing: the page draws each picture. Press the button, then try the arrow keys; on a touch screen, swipe across the photo."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Five sample photos">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => {
              setIndex(0);
            }}
          >
            Open the sample photos
          </Button>
          {index === null ? null : (
            <PhotoViewer
              items={VIEWER_ITEMS}
              index={index}
              onIndexChange={setIndex}
              onClose={() => {
                setIndex(null);
              }}
              note="These are samples: no photo is read from a store."
              // As a receiving screen draws it: the picture in the read's box, and under it a button of the page's, which keeps its size while the picture takes the room that is left.
              renderPicture={(item, { current }) => (
                <>
                  <SampleFullPicture label={item.label} />
                  {current ? (
                    <div className="showcase-photo-act">
                      <Button type="button" variant="secondary" size="lg">
                        Open the sample parcel
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            />
          )}
        </Specimen>
      </div>
    </KitSection>
  );
}

function PhotoUploadSpecimens() {
  const [stored, setStored] = useState<readonly string[]>([]);
  const gate = useUploadGate();
  return (
    <KitSection
      title="EvidenceUpload, photo mode"
      note="For a phone or a tablet at the hub floor: two buttons the size of the hub floor, Take a photo (the camera at the back) and Choose from the gallery, for images and never a document. Each photo is shown back, named by its place and can be retaken. The form below waits for its photos and says so beside the submit, naming what it waits for, also for an upload in a part of the form that is shut. These specimens send nothing: a photo whose file name has the word fail in it is refused."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Photo mode, optional">
          <EvidenceUpload
            mode="photos"
            label="Photos of the damage"
            help="Take a photo of each damaged parcel. Each is sent as soon as you take it."
            upload={madeUpStore}
            failureText={() => 'The photo could not be sent. Try again.'}
            onChange={setStored}
          />
          <p>
            The page holds {String(stored.length)} stored {stored.length === 1 ? 'photo' : 'photos'}
            .
          </p>
        </Specimen>
        <Specimen label="Photo mode, disabled">
          <EvidenceUpload
            mode="photos"
            label="Photos of the damage"
            disabled
            upload={madeUpStore}
            failureText={() => 'The photo could not be sent. Try again.'}
            onChange={nothing}
          />
        </Specimen>
        <Specimen label="A form that waits for its photos">
          <form
            className="showcase-photo-form"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <details>
              <summary>Photos of the seal (a part of the form that is shut)</summary>
              <EvidenceUpload
                mode="photos"
                label="Photos of the seal"
                upload={madeUpStore}
                failureText={() => 'The photo could not be sent. Try again.'}
                onChange={nothing}
                onBusyChange={gate.watch('Photos of the seal')}
              />
            </details>
            <EvidenceUpload
              mode="photos"
              label="Photos of the count"
              upload={madeUpStore}
              failureText={() => 'The photo could not be sent. Try again.'}
              onChange={nothing}
              onBusyChange={gate.watch('Photos of the count')}
            />
            <UploadGateNotice gate={gate} id="showcase-upload-gate" />
            <Button
              type="submit"
              size="lg"
              disabled={gate.busy}
              aria-describedby="showcase-upload-gate"
            >
              Send the count
            </Button>
          </form>
        </Specimen>
      </div>
    </KitSection>
  );
}

function ConnectionBannerSpecimens() {
  const [failed, setFailed] = useState(false);
  return (
    <KitSection
      title="ConnectionBanner"
      note="A line of the page that says what a person does now is not saved, while the browser says it is offline or the page says a request failed for the network. It is a polite status that is in the page before it has anything to say, it cannot be dismissed (it goes when the connection is back), and it never blocks the page. Turn the network off in the browser to see it for real; the box below stands for a request that failed."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Online: nothing is drawn">
          <ConnectionBanner />
          <p>The line above is empty while the connection is there.</p>
        </Specimen>
        <Specimen label="A request failed for the network">
          <Checkbox
            label="Pretend that a request failed"
            checked={failed}
            onChange={(event) => {
              setFailed(event.target.checked);
            }}
          />
          <ConnectionBanner requestFailed={failed} />
        </Specimen>
        <Specimen label="The page's own words">
          <ConnectionBanner
            requestFailed
            words="No connection. The count you are entering is not saved."
          />
        </Specimen>
      </div>
    </KitSection>
  );
}

function HubFloorSpecimens() {
  const [kind, setKind] = useState<string | null>('damaged');
  const [seen, setSeen] = useState(true);
  const options = [
    { value: 'damaged', label: 'Damaged' },
    { value: 'wet', label: 'Wet' },
    { value: 'open', label: 'Opened' },
  ];
  return (
    <KitSection
      title="The hub floor's sizes"
      note="A hub-floor task is tablet-first, with 56 px touch rows and controls (the Product Owner's decision of 5 November 2026): the large size of the button, the radio group and the checkbox, set by the page that is a hub-floor task and never by the component. The target is the whole row, not the small circle or box."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Button, medium and large">
          <div className="showcase-kit-row">
            <Button type="button" variant="secondary">
              Cancel
            </Button>
            <Button type="button" variant="secondary" size="lg">
              Cancel
            </Button>
            <Button type="button" size="lg">
              Send the count
            </Button>
          </div>
        </Specimen>
        <Specimen label="Radio group, large">
          <RadioGroup
            legend="What is wrong with the parcel"
            name="showcase-floor-kind"
            options={options}
            value={kind}
            onChange={setKind}
            size="lg"
          />
        </Specimen>
        <Specimen label="Checkbox, large">
          <Checkbox
            label="I have seen the parcel"
            size="lg"
            checked={seen}
            onChange={(event) => {
              setSeen(event.target.checked);
            }}
          />
        </Specimen>
      </div>
    </KitSection>
  );
}

/** The photo kit of the receiving screens (Run D, S1.35c-0): the grid, the viewer, the photo mode of the evidence upload, the connection banner and the hub floor's sizes. */
export function PhotosGroup() {
  return (
    <>
      <PhotoGridSpecimens />
      <PhotoViewerSpecimen />
      <PhotoUploadSpecimens />
      <ConnectionBannerSpecimens />
      <HubFloorSpecimens />
    </>
  );
}
