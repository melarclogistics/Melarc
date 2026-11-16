import { useMemo } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Icon } from '../../../components/ui/icon/Icon';
import { ReadState, type ReadQuery } from '../../../components/ui/read-state/ReadState';
import {
  usePhotoLink,
  type PhotoLink,
  type PhotoLinkView,
} from '../../../platform/evidence/use-photo-link';
import type { CapabilityWords } from '../../../platform/problem/capability-words';
import {
  PHOTO_BLOCKED,
  PHOTO_TILE_BLOCKED,
  PHOTO_TILE_UNAVAILABLE,
  PHOTO_UNREACHABLE,
} from '../../../platform/problem/pickup-work-copy';
import './photo-picture.css';

/**
 * What a refusal to read a photo is told by, for the viewer's picture: the permission the read needs (the words say what it lets a person do and never the key) and, where the page reads something else
 * with the same key, what it is (words of the table, `capability-words.ts`); `context` is the kind of photo whose refusal the table words differently (`intake`). The page names no key's sentence.
 */
export interface PhotoReading {
  readonly permission: string;
  readonly capability?: CapabilityWords;
  readonly context?: string;
}

export interface PhotoPictureProps {
  /** The evidence record of the photo, asked for the link of while the picture is wanted. Never drawn. */
  readonly evidenceId: string;
  /** Whether the picture is wanted now: a tile near the screen, the photo in the viewer. Until it is, nothing is asked for and nothing is drawn but a placeholder. */
  readonly wanted: boolean;
  /**
   * `tile`: the retrieved original fills a tile's box (cropped to it, never stretched), loaded lazily, with no words of its own (the grid names the tile) and one short plain line when it cannot be shown.
   * `full`: the photo whole, as the content of the viewer, with the cause of a failure told in full.
   */
  readonly size: 'tile' | 'full';
  /** The photo's text alternative where the picture is the content (`full`): its name and when it was taken, in the page's words. Never an identifier or an address. */
  readonly alt?: string;
  /** How a refusal to read the photo is told (`full`). Left out, the refusal is told in the generic words. */
  readonly reading?: PhotoReading;
}

function Unavailable({ words }: { readonly words: string }) {
  return (
    <span className="photo-picture__unavailable">
      <Icon name="photo-unavailable" size="md" />
      <span>{words}</span>
    </span>
  );
}

/** The picture of a tile: a placeholder until it is drawn, and short words that are the same for every cause of failure but a block, which is told as blocked. */
function TilePicture({ view }: { readonly view: PhotoLinkView }) {
  const { link, onImageError } = view;
  switch (link.status) {
    case 'ready':
      return (
        <img
          className="photo-picture photo-picture--tile"
          src={link.url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={onImageError}
        />
      );
    case 'blocked':
      return <Unavailable words={PHOTO_TILE_BLOCKED} />;
    case 'unreachable':
    case 'failed':
      return <Unavailable words={PHOTO_TILE_UNAVAILABLE} />;
    case 'idle':
    case 'loading':
      return (
        <span className="photo-picture__wait">
          <Icon name="photo" size="md" />
        </span>
      );
  }
}

/** What the viewer draws once a link is known: the photo, or the cause of its not being shown, in full. */
function FullPicture({
  link,
  alt,
  onImageError,
}: {
  readonly link: PhotoLink;
  readonly alt: string;
  readonly onImageError: () => void;
}) {
  switch (link.status) {
    case 'ready':
      return (
        <img
          className="photo-picture photo-picture--full"
          src={link.url}
          alt={alt}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={onImageError}
        />
      );
    case 'blocked':
      return (
        <Alert variant="danger">
          <p>{PHOTO_BLOCKED}</p>
        </Alert>
      );
    case 'unreachable':
      return (
        <Alert variant="danger">
          <p>{PHOTO_UNREACHABLE}</p>
        </Alert>
      );
    default:
      return null;
  }
}

/**
 * The viewer's picture, in the states a read owes (`ReadState`): loading in words while a link is on its way or is replaced, the read's own failure in the table's words with a way to try again, and the photo or
 * the cause of its not being shown. The link hook's states are told to it as a query, so that the words, the refusals by key and the retry are exactly those of every other read of the portal.
 */
function FullState({
  view,
  alt,
  reading,
}: {
  readonly view: PhotoLinkView;
  readonly alt: string;
  readonly reading: PhotoReading | undefined;
}) {
  const { link, onImageError, retry } = view;
  const query: ReadQuery<PhotoLink> = useMemo(() => {
    const waiting = link.status === 'idle' || link.status === 'loading';
    return {
      status: link.status === 'failed' ? 'error' : waiting ? 'pending' : 'success',
      data: link.status === 'failed' || waiting ? undefined : link,
      error: link.status === 'failed' ? link.error : undefined,
      refetch: retry,
      isFetching: link.status === 'loading',
    };
  }, [link, retry]);
  return (
    <ReadState<PhotoLink>
      query={query}
      isEmpty={() => false}
      empty={null}
      loadingLabel="Opening the photo…"
      operation="createEvidenceRetrievalAuthorization"
      {...(reading === undefined ? {} : { permission: reading.permission })}
      {...(reading?.capability === undefined ? {} : { capability: reading.capability })}
      {...(reading?.context === undefined ? {} : { context: reading.context })}
    >
      {(data) => <FullPicture link={data} alt={alt} onImageError={onImageError} />}
    </ReadState>
  );
}

/**
 * The picture of one stored photo, for a tile of the photo grid and for the viewer that opens on it (COMPONENT_PATTERNS, *PhotoGrid* and *PhotoViewer*). It draws what the platform's link hook gives
 * (`usePhotoLink`: asked for only while `wanted`, shared by the tile and the viewer that open the same photo, renewed once when the picture would not load, told as blocked when the browser's own policy
 * stopped it) and says in words what the person needs when it cannot. **No small copy of a photo is made yet** (OB-S1-86, part 2): a tile draws the retrieved original in a fixed box, cropped to it, which is
 * provisional and is said so in the pattern. **No address, key or identifier is ever drawn as text**: the address is held by the `<img>` alone, and a picture is named by the words the page gives it.
 */
export function PhotoPicture({ evidenceId, wanted, size, alt, reading }: PhotoPictureProps) {
  const view = usePhotoLink(evidenceId, wanted);
  return size === 'tile' ? (
    <TilePicture view={view} />
  ) : (
    <FullState view={view} alt={alt ?? ''} reading={reading} />
  );
}
