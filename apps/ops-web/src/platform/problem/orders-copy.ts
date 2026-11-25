import { cannotText } from './capability-words';
import type { CopyRule } from './problem-copy';
import { SENIOR_DECIDES } from './receiving-copy';

/**
 * The words of the order screens (S1.40: the orders of a vendor, the order form and its review, an order's record, the amendment, the close, the summary, the payer corrections and the closes that left
 * work), in the one table, keyed by operation, context and code like the rest of it. **All of them are drafts, proposed for the Product Owner to review with the composed screens.** They speak the vocabulary
 * of the floor, which is the owner's: *vendor, parcel, order, size, price, who pays, close*. **No wording on these screens says** *intake*, *itemise*, *adjudicate*, *reconciliation*, *advisory lock*, *the
 * server*, *token*, a key or a role, nor explains how the system works in the voice of the people who built it (`orders-copy.test.ts` reads every rule and every string and fails on one). A refusal names the
 * capability in plain words and never a key or a role (PRODUCT_DESIGN_DIRECTION section 6.5), says what happened to what the officer was doing, and says what to do next, because a refusal shown as a
 * dead end misrepresents the policy. A refusal that declares a `details.rule` is worded by it (`problemOf` reads the rule as the context when the page gave none).
 *
 * **Nothing here works a figure out.** A price, a total, a portion and a date are the server's and are drawn as it gave them; the words around them say what they are and what they are not.
 */

const orders = (count: number): string => (count === 1 ? '1 order' : `${String(count)} orders`);
const parcels = (count: number): string => (count === 1 ? '1 parcel' : `${String(count)} parcels`);

/** What the order made early for a parcel that is missing says, on the order's page and on the parcel's row (D-D6), and once the vendor's missing parcels are written off (D-S7-4): drafts, said once and drawn in both places. */
const PARCEL_MISSING_ORDER =
  'Parcel missing — this order will not go out unless the parcel is found.';
const PARCEL_NOT_RECEIVED_ORDER =
  'Parcel not received — the order stays on record, with no price to pay, and will not go out.';

export const ORDERS_WORDS = {
  common: {
    receiving: 'Receiving',
    back: 'Back to the vendor',
    backToOrders: 'Back to the orders',
    /** The reference a refusal carries, for an officer who rings for help. */
    reference: (reference: string): string => `Reference: ${reference}`,
    loading: 'Loading…',
    notFoundVendor: 'This vendor could not be found.',
    notFoundOrder: 'This order could not be found.',
    parcel: (ordinal: number): string => `Parcel ${String(ordinal)}`,
    extraParcel: (ordinal: number): string => `Parcel ${String(ordinal)} (added at the hub)`,
    orders,
    parcels,
    blindVendor: 'Counted without photos',
    unknownState: 'Unknown',
  },

  // The orders of one vendor: the work that is really left.
  workspace: {
    title: (vendor: string | undefined): string =>
      vendor === undefined ? 'Orders' : `Orders for ${vendor}`,
    description:
      'Make an order for each parcel that arrived, then close the vendor. What is left to do is counted here.',
    viewsLabel: 'Views of the orders',
    tableLabel: 'Parcels and orders',
    noun: { plural: 'parcels', one: 'parcel', other: 'parcels' },
    views: {
      all: { label: 'All', none: 'There is nothing to list yet.' },
      needs_order: { label: 'Needs an order', none: 'Every parcel that arrived has an order.' },
      awaiting_arrival: {
        label: 'Not here yet',
        none: 'No parcel is still on its way to the table.',
      },
      prepared: { label: 'Waiting for its parcel', none: 'No order is waiting for its parcel.' },
      itemized: { label: 'Confirmed', none: 'No order is confirmed yet.' },
      payment_required: { label: 'Payment due', none: 'No order is waiting for payment.' },
      missing: { label: 'Missing', none: 'No parcel is missing.' },
      waiting_for_vendor: {
        label: 'Waiting for the vendor’s details',
        none: 'No parcel is waiting for the vendor’s details.',
      },
    },
    /** A parcel the officer is waiting on the vendor's details for (D-S7-12): said on its row, beside where it stands, with the officer's note if there is one. */
    waiting: {
      label: 'Waiting for the vendor’s details',
    },
    columns: {
      parcel: 'Parcel',
      order: 'Order',
      recipient: 'Recipient',
      size: 'Size',
      standing: 'Where it stands',
    },
    state: {
      NEEDS_ORDER: 'Needs an order',
      AWAITING_ARRIVAL: 'Not here yet',
      PREPARED: 'Waiting for its parcel',
      ITEMIZED: 'Confirmed — price fixed',
      MISSING: 'Missing',
    },
    paymentDue: 'Payment due',
    reversed: (code: string): string => `The earlier order ${code} was taken back.`,
    acts: {
      makeNext: 'Make the next order',
      makeOrder: 'Make order',
      makeOrderFor: (ordinal: number): string => `Make an order for parcel ${String(ordinal)}`,
      openOrder: 'Open order',
      makeBlind: 'Make an order',
      makeOrders: 'Make orders',
      seeOrders: 'See the orders',
      /** The way in to the orders of a vendor whose check-in is still open (D-D6): from the vendor's section of the run, from its record and from Orders to make. A draft, with the rest of the table. */
      earlyOrders: 'Start orders from the photos',
      close: 'Close this vendor',
      summary: 'See the summary',
      closedExceptions: 'Closed with parcels left',
      openVendor: 'Open the vendor',
    },
    progress: {
      title: 'Where it stands',
      arrived: 'Arrived',
      needsOrder: 'Need an order',
      made: 'Orders made',
      notConfirmed: 'Not confirmed',
      paymentDue: 'Payment due',
      missing: 'Missing',
      waiting: 'Not here yet',
      awaitingCount: 'Waiting for the count',
    },
    blind: {
      awaitingCount:
        'The count has not been recorded yet, so how many orders are needed is not known.',
      remaining: (count: number): string =>
        count === 1 ? '1 more order needed.' : `${String(count)} more orders needed.`,
      complete: (received: number): string =>
        received === 1
          ? 'The parcel has its order.'
          : `All ${String(received)} parcels have an order.`,
      note: 'This vendor was counted without photos, so there is no photo to match: make one order for each parcel received.',
    },
    notes: {
      allDone: 'Every parcel that arrived has an order. Close the vendor when you are done.',
      closed: 'This vendor is closed. Its orders can no longer be changed here.',
      early:
        'An order made for a parcel that is not here yet keeps the price it was calculated at, and is confirmed when the check-in is final.',
      notCleared: 'This vendor is not cleared for orders yet.',
      /** A vendor whose check-in is final and that waits for a senior officer's decision about what is missing or damaged: what is in the way is not the check-in, and is not the officer's. */
      inReview:
        'A senior officer is deciding what to do about the missing or damaged parcels. Orders can be made once that is done.',
      checkInOpen:
        'The vendor is still being checked in. You can make orders now for the parcels that are not here yet, from their photos: each is confirmed when the check-in is final. The parcels that are here can be ordered once it is.',
    },
    panel: {
      photo: 'Photo of the parcel',
      noPhoto: 'This parcel has no photo.',
      facts: {
        parcel: 'Parcel',
        order: 'Order',
        recipient: 'Recipient',
        area: 'Area',
        size: 'Size',
        standing: 'Where it stands',
      },
      notYet:
        'The parcel is not checked in yet. You can make its order now: it is confirmed when the check-in is final.',
      missing:
        'The parcel is missing, so no order can be confirmed for it. If it is found, check it in from the missing list.',
      /** The order made early for a parcel that is missing (D-D6): it stays on the list as missing, is never priced or sent, and is only told what would change that. Drafts. */
      missingOrder: PARCEL_MISSING_ORDER,
      /** The same order once the vendor's missing parcels were written off (D-S7-4): it stays as a record, with no price to pay. */
      notReceived: PARCEL_NOT_RECEIVED_ORDER,
    },
    problems: {
      readOrders: 'The orders could not be read.',
    },
  },

  // The form of one order, and the review before anything is saved.
  form: {
    title: 'Make an order',
    titleFor: (ordinal: number): string => `Make an order for parcel ${String(ordinal)}`,
    description:
      'Fill in what the parcel needs. The price shows beside the form by itself, and nothing is saved until you press the save.',
    documentTitle: 'Make an order',
    breadcrumbVendor: (vendor: string | undefined): string => vendor ?? 'The vendor',
    breadcrumbOrders: 'Orders',
    noParcelTitle: 'Choose a parcel',
    noParcel: 'Every parcel that arrived has an order.',
    chooseParcel: 'Choose a parcel',
    parcelNotAvailable:
      'This parcel cannot have an order made for it here. Go back to the orders and choose another.',
    blindNoPlace: 'Every parcel received already has an order.',
    blindAwaitingCount:
      'The count has not been recorded yet, so orders cannot be made for this vendor.',
    closedVendor: 'This vendor is closed, so no more orders can be made for it.',
    sections: {
      parcel: 'The parcel',
      recipient: 'The recipient',
      size: 'Size',
      destination: 'Where it goes',
      carrier: 'The carrier’s charge',
      value: 'Value and goods',
      date: 'Delivery date',
      payer: 'Who pays',
      reason: 'Why you are changing it',
    },
    fields: {
      name: 'Recipient’s name',
      phone: 'Recipient’s phone',
      phoneHelp: 'As the recipient gave it, for example 024 123 4567.',
      /** Guidance while the number is typed, never a refusal: the officer may know better than a pattern does. */
      phoneLook: 'This doesn’t look like a Ghana number. Check it, for example 024 123 4567.',
      address: 'Delivery address',
      addressHelp: 'The area or a landmark helps us find the zone.',
      landmark: 'Landmark',
      size: 'Size of the parcel',
      sizeHelp: 'You judge the size by looking at the parcel. Nothing is chosen for you.',
      destination: 'Where does the parcel go?',
      carrierCost: 'The carrier’s charge (GH₵)',
      carrierCostHelp: 'As written on the carrier’s waybill.',
      waybill: 'Photo of the waybill',
      waybillHelp: 'Take a photo of the carrier’s waybill.',
      declaredValue: 'Declared value (GH₵)',
      declaredValueHelp: 'Leave empty if no value was declared.',
      highValue: 'Treat this parcel as high value',
      highValueHelp: 'A high-value parcel is handled with more care and needs photos of it.',
      evidence: 'Photos of the high-value parcel',
      evidenceHelp: 'Take photos that show what the parcel is.',
      serialized: 'This parcel has a serial number or IMEI',
      serial: 'Serial number or IMEI',
      requestedDate: 'Delivery date asked for',
      requestedDateHelp: 'Leave empty to use the first day we can deliver.',
      payer: 'Who pays for the delivery?',
      payerHelp: 'Leave it as booked unless this parcel is paid for differently.',
      splitBasis: 'How is it split?',
      splitAmount: 'The sender pays (GH₵)',
      splitPercentage: 'The sender pays (%)',
      zone: 'Which zone is it?',
      zoneHelp: 'The address matches more than one zone. Choose the right one.',
      /** For an address no zone of the hub matches (D-S7-5): the officer who knows the zone chooses it, and says why. */
      zoneUnresolvedHelp:
        'The address does not match a zone of this hub. Choose the zone the address is in, and say why.',
      zoneNote: 'Why this zone',
      zoneNoteHelp: 'A few words, so it can be checked later.',
      reason: 'Why are you changing this order?',
      reasonHelp: 'A few words. It is kept with the change.',
    },
    destinations: {
      DOORSTEP: { label: 'To the recipient’s door', help: 'Inside the area we deliver in.' },
      STATION_DROP: { label: 'Dropped at a station', help: 'The recipient collects it there.' },
      CARRIER: {
        label: 'Sent by a carrier outside our area',
        help: 'We pay the carrier and add our margin.',
      },
    },
    sizes: { SMALL: 'Small', MEDIUM: 'Medium', LARGE: 'Large' },
    payers: {
      AS_BOOKED: { label: 'As booked', help: 'The pickup request says who pays.' },
      RECIPIENT_PAYS: { label: 'The recipient pays' },
      SENDER_PAYS_FULL: { label: 'The sender pays all of it' },
      SPLIT: { label: 'Split between the sender and the recipient' },
    },
    splitBases: { FIXED_AMOUNT: 'A fixed amount', PERCENTAGE: 'A percentage' },
    photoOf: 'Photo of the parcel',
    noPhoto: 'This parcel has no photo.',
    /** The price beside the form: it is worked out by the server as the parcel is filled in, and the officer never types it. */
    price: {
      title: 'The price',
      waiting: 'The price shows here once the parcel is filled in. You never type it.',
      checking: 'Checking the price…',
      refused:
        'The price could not be worked out for what you entered. The fields marked say what to change.',
      /** The check itself failed (the network, a fault, too many requests): no field is at fault, and nothing entered is lost. */
      failed: 'The price could not be checked.',
      /** Beside the save, which cannot be pressed while the price could not be checked (Run G1, Part 2, item 8): the price column that explains it is a screen above at 768 px. */
      failedBesideSave: 'The price could not be checked, so the order cannot be saved yet.',
      kept: 'Your entries are kept.',
    },
    /** The line above the save: what was typed, so that the officer reads what is about to be saved. */
    typed: 'What you typed',
    acts: {
      save: 'Save the order',
      saveAt: (price: string): string => `Save the order at ${price}`,
      saveChange: 'Save the change',
      saveChangeAt: (price: string): string => `Save the change at ${price}`,
      /** After the price changed at the save: a button of its own, which says the new figure. */
      saveAtNew: (price: string): string => `Save at ${price}`,
      checking: 'Checking the price…',
      cancel: 'Back to the orders',
      checkAgain: 'Check the price again',
      retry: 'Try again',
    },
    errors: {
      name: 'Enter the recipient’s name.',
      phone: 'Enter the recipient’s phone number.',
      phoneFormat: 'That doesn’t look like a phone number. Check the digits.',
      address: 'Enter the delivery address.',
      size: 'Choose the size of the parcel.',
      destination: 'Choose where the parcel goes.',
      carrierCost: 'Enter the carrier’s charge as an amount, for example 45.00.',
      waybill: 'Add a photo of the carrier’s waybill.',
      declaredValue: 'Enter the declared value as an amount, for example 250.00.',
      evidence: 'A high-value parcel needs at least one photo.',
      serial: 'Enter the serial number or IMEI.',
      payer: 'Choose who pays.',
      splitBasis: 'Choose how the delivery is split.',
      splitAmount: 'Enter what the sender pays as an amount, for example 10.00.',
      splitPercentage: 'Enter what the sender pays as a percentage from 0 to 100.',
      zone: 'Choose the zone.',
      zoneNote: 'Say why you chose this zone.',
      reason: 'Write why you are changing this order.',
      noChange: 'Nothing was changed. Change something, or go back.',
    },
    sending: 'Saving the order…',
    checkInOpen:
      'The vendor is still being checked in, so the parcels that are here cannot be ordered yet. Finish the check-in first.',
    /** The early orders (D-D6, Run G2, Part 2, item 1): every parcel that is not here yet has its order, or is waited on, while the vendor is still being checked in. Drafts. */
    earlyNone:
      'Every parcel that is not here yet has an order. The parcels that are here can be ordered once the check-in is finished.',
    /** After an order made for a parcel that is not here yet: what it waits for, and when it is confirmed. */
    earlySaved:
      'The order waits for its parcel. It is confirmed, and its price fixed, when the vendor’s check-in is final.',
    unknownOutcome:
      'We could not tell whether the order was saved. Look at the orders before you try again.',
    checkRecord: 'Look at the orders',
    /** A parcel the officer is waiting on the vendor's details for (D-S7-12, 24 November 2026): marked on the server so that every officer and tablet sees it; the note is one short line and holds no number. */
    waiting: {
      button: 'Waiting for the vendor’s details',
      title: 'Waiting for the vendor’s details',
      consequence:
        'The other officers will see that you are waiting for the vendor for this parcel. Make its order when you have what you need.',
      noteLabel: 'What you asked, and how',
      noteHelp:
        'For example: Called the vendor, waiting on WhatsApp. Leave the number out of the note.',
      confirm: 'Mark the parcel',
      cancel: 'Cancel',
      numberInNote: 'Leave the number out of the note.',
      badNote: 'Write one short line, without a number or an address.',
      marked: 'You are waiting for the vendor’s details for this parcel.',
      takeOff: 'Take the mark off',
      hasOrder: (ordinal: number, code: string): string =>
        `Parcel ${String(ordinal)} already has its order, ${code}.`,
      openOrder: 'Open the order',
      allWaiting: 'Every parcel that is left is waiting for the vendor’s details.',
      seeWaiting: 'See the parcels that wait',
    },
    done: (code: string): string => `Order ${code} is saved.`,
    /** What a vendor with door photos has left, after an order is saved: the server's count of the whole vendor. */
    parcelsLeft: (count: number): string =>
      count === 1 ? '1 parcel needs an order.' : `${String(count)} parcels need an order.`,
    doneAmend: (code: string): string => `Order ${code} was changed.`,
    /** After an order of a vendor counted without photos is saved (D-S7-3, 23 November 2026): the code is what the officer writes on the parcel, and the count says where the vendor stands. */
    blindSaved: {
      writeOnParcel: 'Write this code on the parcel.',
      position: (made: number, received: number): string =>
        `Order ${String(made)} of ${String(received)} for this vendor.`,
      lastTitle: 'The last orders of this vendor',
      lastNone: 'The last orders could not be read.',
    },
    /** The order that was just made, opened from the saved screen (Run G1, Part 2, item 11: named for what it opens). */
    open: 'Open this order',
    another: 'Make another',
    uploading: 'A photo is still being saved. Wait for it to finish.',
    photoFailed: 'The photo could not be saved. Try again.',
    amendTitle: (code: string): string => `Change order ${code}`,
    amendDescription:
      'Change what was written down wrongly. The price is worked out again beside the form, and nothing is changed until you press the save.',
    amendNotAllowed:
      'This order is confirmed, so it cannot be changed here. To change who pays, ask for a correction.',
    amendClosed: 'The vendor is closed, so this order cannot be changed.',
    amendReversed: 'This order was taken back, so it cannot be changed.',
  },

  // What confirming would give, as the server worked it out.
  review: {
    title: 'Check the order',
    priceSection: 'Price',
    total: 'Price',
    components: 'What the price is made of',
    surcharge: 'High-value charge',
    destinationSection: 'Where it goes',
    zone: 'Zone',
    area: 'Area',
    outside: 'Outside our area',
    chosen: 'Zone chosen by you',
    byAddress: 'Found from the address',
    deliverySection: 'Delivery',
    committed: 'Delivery date',
    asked: 'Date asked for',
    firstDay: 'First day we can deliver',
    window: 'Delivery window',
    payerSection: 'Who pays',
    senderPays: 'The sender pays',
    recipientPays: 'The recipient pays',
    asBooked: 'As booked on the pickup',
    forThisOrder: 'Set for this order',
    afterSection: 'After you confirm',
    evidenceOk: 'The photos are saved.',
    cited: (count: number): string =>
      count === 1
        ? '1 photo of the parcel is attached.'
        : `${String(count)} photos of the parcel are attached.`,
    waybillCited: 'The waybill photo is attached.',
    willConfirm: {
      ON_CONFIRMATION: 'The order is confirmed when you save it, and the price is fixed.',
      WHEN_ARRIVAL_IS_COMMITTED:
        'The parcel is not checked in for good yet. The order is saved at this price and confirmed when the check-in is final. The price is kept as it is until you change the order.',
    },
    gate: {
      NO_VENDOR_CHARGE: 'The sender pays nothing, so nothing is charged to the vendor.',
      PAYMENT_REQUIRED:
        'The sender owes an amount, so the order waits for payment before it can go out.',
    },
    kinds: {
      SERVICE_AREA_BASE_FEE: 'Delivery inside our area',
      CORRIDOR_OFF_DAY_FEE: 'Delivery on a day outside the corridor’s batch day',
      STATION_DROP_FEE: 'Station drop',
      HIGH_VALUE_SURCHARGE: 'High-value charge',
      SIZE_CLASS_SURCHARGE: 'Size charge',
      CARRIER_COST: 'The carrier’s charge',
      OUTSIDE_ACCRA_MARGIN: 'Our margin',
    },
    unknownKind: 'Other charge',
    changed: {
      title: 'The terms changed while you were looking',
      text: 'What this order comes to is not what you read. Read the new figures, then save again.',
      price: (before: string, after: string): string => `Price: ${before} before, ${after} now.`,
      date: (before: string, after: string): string =>
        `Delivery date: ${before} before, ${after} now.`,
      payer: 'Who pays has changed.',
      evidence: 'The photos attached have changed.',
      zone: 'The zone has changed.',
      highValue: 'Whether the parcel is high value has changed.',
      other: 'Other terms have changed.',
    },
    changing: {
      title: 'The hub’s prices are being changed',
      text: 'They changed more than once while your order was being saved, so nothing was saved. Check the price again.',
    },
    stale: {
      title: 'This vendor changed while you were working',
      text: 'Your entries are kept. Check the price again to go on.',
    },
    beforeAmend: {
      title: 'The order now',
      total: 'Price it holds now',
      date: 'Delivery date it holds now',
      highValue: 'High value now',
      yes: 'Yes',
      no: 'No',
    },
  },

  // An order's own page.
  record: {
    documentTitle: (code: string): string => `Order ${code}`,
    status: {
      EARLY_QUOTE: 'Waiting for its parcel',
      FROZEN: 'Confirmed — price fixed',
      REVERSED: 'Taken back',
      // The order made early for a parcel that is missing (D-D6), and once the vendor's missing parcels are written off (D-S7-4). Drafts.
      PARCEL_MISSING: 'Parcel missing',
      PARCEL_NOT_RECEIVED: 'Parcel not received',
    },
    sentence: {
      EARLY_QUOTE:
        'Made before the parcel was checked in for good. Its price is kept as calculated and it is confirmed when the check-in is final.',
      FROZEN: 'Confirmed: its price is fixed.',
      REVERSED:
        'The arrival was taken back, so the order no longer stands. The price and the history are kept.',
      PARCEL_MISSING: PARCEL_MISSING_ORDER,
      PARCEL_NOT_RECEIVED: PARCEL_NOT_RECEIVED_ORDER,
    },
    sections: {
      /** The photo of the parcel the order is made for (D-S7-14): a tile that opens it whole. */
      photo: 'The parcel’s photo',
      holds: 'What it holds',
      price: 'The price',
      payer: 'Who pays',
      history: 'What happened',
    },
    facts: {
      recipient: 'Recipient',
      phone: 'Phone',
      address: 'Address',
      landmark: 'Landmark',
      size: 'Size',
      destination: 'Where it goes',
      zone: 'Zone',
      declared: 'Declared value',
      highValue: 'High value',
      serial: 'Serial number or IMEI',
      requested: 'Date asked for',
      committed: 'Delivery date',
      carrier: 'The carrier’s charge',
      parcel: 'Parcel',
      vendor: 'Vendor',
      state: 'Where it stands',
      payment: 'Payment',
      hub: 'Hub',
    },
    price: {
      earlyQuote: 'Calculated price (not fixed)',
      frozen: 'Fixed price',
      earlyHelp: 'This is the price it was calculated at. It is fixed when the order is confirmed.',
      // An order whose parcel is missing is not confirmed unless the parcel is found, and one whose parcel was not received owes nothing.
      missingHelp:
        'This is the price it was calculated at. It is fixed only if the parcel is found and checked in.',
      notReceivedHelp: 'The parcel was not received, so nothing is owed for this order.',
      frozenHelp: 'This is the price. A correction changes who pays, never this figure.',
      estimateNote:
        'The estimate shown when the pickup was booked is on the pickup, and it is not this price.',
      none: 'No price was read.',
    },
    destinations: {
      DOORSTEP: 'To the recipient’s door',
      STATION_DROP: 'Dropped at a station',
      CARRIER: 'Sent by a carrier outside our area',
    },
    yes: 'Yes',
    no: 'No',
    manualHighValue: 'You marked it high value',
    byDeclaration: 'The declared value makes it high value',
    commercial: {
      NO_VENDOR_CHARGE: 'Nothing to pay: the sender is not charged',
      PAYMENT_REQUIRED: 'Waiting for payment',
      CREDIT_RESERVED: 'Reserved against the vendor’s credit',
      PREPAID: 'Paid in advance',
      PRICED: 'Priced',
      CLOSED: 'Closed',
      REVERSED: 'Taken back',
    },
    payer: {
      sender: 'The sender pays',
      recipient: 'The recipient pays',
      asBooked: 'As booked on the pickup',
      override: 'Set for this order',
      notYet: 'Worked out when the order is confirmed.',
    },
    history: {
      amended: (changed: string): string => `Changed: ${changed}.`,
      /** The correction of a confirmed order's recipient (Run G2, Part 1, item 3): which parts of the recipient it corrected, in the words of `changedMembers`. A draft, with the rest of the table. */
      corrected: (parts: string): string => `Corrected the recipient: ${parts}.`,
      reversed: 'The arrival was taken back.',
      note: (note: string): string => `Reason: ${note}`,
      current: 'Now',
    },
    changedMembers: {
      recipient: 'the recipient',
      // The parts of the recipient that a correction names (Run G2, Part 1, item 3; contract 5.121.0).
      'recipient.name': 'the name',
      'recipient.phone': 'the phone number',
      'recipient.address': 'the address',
      size_class: 'the size',
      carrier_cost: 'the carrier’s charge',
      carrier_waybill_evidence_id: 'the waybill photo',
      is_high_value: 'the high-value flag',
      lane: 'where it goes',
      commercial_mode: 'where it goes',
      payer_override: 'who pays',
      declared_value_minor: 'the declared value',
      is_serialized_goods: 'the serial number',
      serial_imei: 'the serial number',
      requested_delivery_date: 'the date asked for',
      destination_zone_authorization: 'the zone',
      evidence_ids: 'the photos',
    } as Readonly<Record<string, string>>,
    unknownMember: 'something',
    acts: {
      amend: 'Change this order',
      reverse: 'Take back the arrival',
      correct: 'Change who pays',
      correctRecipient: 'Correct the recipient',
      openCorrection: 'Open the correction',
      openVendor: 'Open the orders',
      /** The link that opens one order, from the change page (it was named Open the orders, the name of the link that opens a vendor's orders). */
      openOrder: 'Open this order',
    },
    notes: {
      seniorReverses: 'A senior officer takes back an arrival.',
      correctionOpen: 'A change of who pays is waiting for a decision.',
    },
    loading: 'Loading the order…',
    stale: 'This order changed after you opened it. Reload to see it as it is now.',
    reverseDone: (received: number): string =>
      `The arrival was taken back. The vendor now counts ${parcels(received)} received and is back in review.`,
    correctionDone: 'The change was asked for. A senior officer decides it.',
  },

  reverse: {
    title: 'Take back the arrival',
    description: (code: string): string =>
      `Order ${code} stays on record with its price and its history. The parcel goes back to the missing list, and the vendor goes back in review. No more orders can be made for this vendor until a senior officer decides.`,
    reasonLabel: 'Why is the arrival being taken back?',
    reasonHelp: 'For example: the parcel was marked as here by mistake. It is kept with the act.',
    confirm: 'Take back the arrival',
    cancel: 'Cancel',
    sending: 'Taking back the arrival…',
    reasonRequired: 'Write why the arrival is being taken back.',
    unknown:
      'We could not tell whether the arrival was taken back. Look at the order before you try again.',
    lookAtOrder: 'Look at the order',
  },

  correct: {
    title: 'Change who pays',
    description: (code: string): string =>
      `The price of order ${code} is fixed and does not change. You ask for a different split of it, and a senior officer decides.`,
    payerLabel: 'Who should pay?',
    reasonLabel: 'Why should it change?',
    reasonHelp: 'A few words. The senior officer reads it.',
    confirm: 'Ask for the change',
    cancel: 'Cancel',
    sending: 'Sending the request…',
    reasonRequired: 'Write why who pays should change.',
    unknown:
      'We could not tell whether the request was sent. Look at the order before you try again.',
    lookAtOrder: 'Look at the order',
  },

  // The recipient of a confirmed order, corrected after the price is fixed (D-S7-1, 23 November 2026).
  recipient: {
    title: 'Correct the recipient',
    description: (code: string): string =>
      `Order ${code} is confirmed and its price is fixed. Correct the name, the phone or the address if it was written down wrongly. The price, the zone and the delivery date do not change, and the old details are kept in the order’s history with your reason.`,
    addressHelp:
      'An address can be corrected while it stays in the same zone. One in another zone changes the price, and that cannot be done here yet.',
    reasonLabel: 'Why are you correcting this?',
    reasonHelp: 'For example: the phone number had a digit wrong. It is kept with the correction.',
    confirm: 'Save the correction',
    cancel: 'Cancel',
    reasonRequired: 'Write why you are correcting this.',
    /** The reason holds a phone number (the notes of every act refuse one, Part 1 item 5): said on the reason, in its own words. */
    numberInReason: 'Leave the number out of the reason.',
    reasonRefused: 'This reason was not accepted as written. Write it again in other words.',
    nothingChanged: 'Nothing was changed. Correct a detail, or cancel.',
    done: (code: string): string => `The recipient of order ${code} was corrected.`,
  },

  // What closing finds, and the close.
  close: {
    title: (vendor: string | undefined): string =>
      vendor === undefined ? 'Close the vendor' : `Close ${vendor}`,
    documentTitle: 'Close the vendor',
    description:
      'Check what closing finds before you close. Closing is final: it does not collect any payment and does not send anything out.',
    sections: {
      facts: 'What closing finds',
      parcels: 'Parcels with no order yet',
      exception: 'Close with parcels still to order',
    },
    facts: {
      received: 'Received',
      ordered: 'Orders made',
      outstanding: 'Still without an order',
      unpriced: 'Not priced',
      paymentDue: 'Payment due',
      missing: 'Missing',
      awaitingCount: 'Waiting for the count',
    },
    standing: {
      ready: 'Every parcel received has an order. You can close this vendor.',
      needsException:
        'Some parcels received still have no order. Make their orders, or a senior officer can close with a reason.',
      notReady: 'This vendor cannot be closed yet.',
      closed: 'This vendor is closed.',
      closedWithException: 'This vendor was closed with parcels still to order.',
    },
    blockers: {
      intake_not_ready: 'The vendor is not cleared for orders yet. Finish the check-in first.',
      orders_exceed_received:
        'There are more orders than parcels received. Correct the extra order before closing: a close never covers it.',
      order_unpriced:
        'An order for a parcel that arrived has no price yet. Confirm it before closing.',
    },
    displayLimit: (shown: number, total: number): string =>
      `Showing ${String(shown)} of ${String(total)} parcels. The rest are in the orders, under “Needs an order”.`,
    seeAllOutstanding: 'See them in the orders',
    paymentStill:
      'Closing is not payment and does not send anything out. Orders that wait for payment stay blocked until they are paid.',
    acts: {
      close: 'Close this vendor',
      closeWithException: 'Close with a reason',
      cancel: 'Back to the orders',
      reload: 'Read it again',
    },
    exception: {
      intro:
        'Only a senior officer can close while parcels received have no order. The parcels left are named above, and your reason is kept with the close.',
      reasonLabel: 'Why are you closing with parcels still to order?',
      reasonHelp: 'Say what happened and who follows it up. It is kept with the close.',
      reasonRequired: 'Write why you are closing with parcels still to order.',
      // Parcels still to order are the officer's (D-S7-11): the officer calls or messages the vendor and makes the order, and a senior closes with a reason only when that cannot be done.
      mustAsk:
        'Only a senior officer can close while parcels received have no order. Make their orders: call or message the vendor for what is missing.',
    },
    confirm: {
      title: 'Close this vendor?',
      body: (received: number | null, ordered: number): string =>
        received === null
          ? `${orders(ordered)} made.`
          : `${parcels(received)} received and ${orders(ordered)} made.`,
      exceptionBody: (outstanding: number): string =>
        outstanding === 1
          ? '1 parcel received will stay without an order. This cannot be undone here.'
          : `${String(outstanding)} parcels received will stay without an order. This cannot be undone here.`,
      yes: 'Yes, close it',
      no: 'Cancel',
    },
    changed: {
      title: 'What closing finds has changed',
      text: 'Another officer changed this vendor while you were reading. The new figures are shown. Your reason is kept: read it again and confirm.',
    },
    stale: {
      title: 'This vendor changed while you were reading',
      text: 'The figures were read again. Your reason is kept: read them, then confirm.',
    },
    done: {
      closed: 'The vendor is closed.',
      closedWithException: 'The vendor is closed, with parcels still to order.',
      paymentDue: (count: number): string =>
        count === 1
          ? 'Payment is still due on 1 order. Closing did not collect it.'
          : `Payment is still due on ${String(count)} orders. Closing did not collect it.`,
    },
    loading: 'Reading what closing finds…',
    sending: 'Closing…',
    unknown: 'We could not tell whether the vendor was closed. Read it again before you try again.',
    seeSummary: 'See the summary',
  },

  // The orders of a closed vendor, as the hub has them.
  summary: {
    title: (vendor: string | undefined): string =>
      vendor === undefined ? 'Summary' : `Summary for ${vendor}`,
    documentTitle: 'Summary of a closed vendor',
    description: 'The orders the hub made for this vendor, as the vendor reads them.',
    notClosed: 'This vendor is not closed yet, so it has no summary.',
    columns: {
      order: 'Order',
      recipient: 'Recipient',
      area: 'Area',
      size: 'Size',
      price: 'Price',
      whoPays: 'Who pays',
      standing: 'Where it stands',
    },
    /** Who pays what of an order's price, from the amounts the server gave (the vendor's portion and the recipient's: D-S7-10). */
    whoPays: (sender: string, recipient: string): string =>
      `Sender ${sender}, recipient ${recipient}`,
    noPrices: 'Prices are not shown to your account. You can see the orders and where each stands.',
    empty: 'This vendor closed with no orders.',
    closedAt: 'Closed',
    said: {
      title: 'What was said about this',
      none: 'No message about this has been recorded yet.',
      help: 'The messages the platform recorded for this pickup, and what became of each.',
      open: 'Open the message log',
    },
    loading: 'Loading the summary…',
    seeOrders: 'See the orders',
  },

  // Who pays, after the price is fixed: the checker's queue and one correction.
  corrections: {
    title: 'Changes of who pays',
    description:
      'Decide the requests to change who pays for an order whose price is fixed. The price itself never changes.',
    viewsLabel: 'Views of the changes of who pays',
    tableLabel: 'Changes of who pays',
    noun: {
      plural: 'changes of who pays',
      one: 'change of who pays',
      other: 'changes of who pays',
    },
    views: {
      REQUESTED: { label: 'Waiting', none: 'Nothing is waiting for a decision.' },
      APPROVED: { label: 'Approved', none: 'No change has been approved yet.' },
      REJECTED: { label: 'Rejected', none: 'No change has been rejected yet.' },
      all: { label: 'All', none: 'No change of who pays has been asked for yet.' },
    },
    columns: { order: 'Order', asked: 'Asked', proposed: 'Asked for', standing: 'Where it stands' },
    state: { REQUESTED: 'Waiting for a decision', APPROVED: 'Approved', REJECTED: 'Rejected' },
    sections: { change: 'The change', why: 'Why', history: 'What happened' },
    facts: {
      order: 'Order',
      price: 'Price (fixed)',
      before: 'Paid like this now',
      after: 'Asked for',
      afterState: 'After approval the order',
      requestedBy: 'Asked by',
      requestedAt: 'Asked',
      decidedBy: 'Decided by',
      decidedAt: 'Decided',
      result: 'What the approval did',
      note: 'Reason given',
    },
    amounts: (sender: string, recipient: string): string =>
      `The sender pays ${sender} and the recipient pays ${recipient}.`,
    acts: {
      approve: 'Approve',
      reject: 'Reject',
      openOrder: 'Open the order',
      openFull: 'Open the change',
    },
    decide: {
      approveTitle: 'Approve this change?',
      rejectTitle: 'Reject this change?',
      approveBody:
        'The order is paid for as asked, and the hub checks again whether payment is due. The price does not change.',
      rejectBody: 'Nothing changes on the order.',
      noteLabel: 'Note (optional)',
      noteHelp: 'A few words for the record.',
      approveYes: 'Yes, approve',
      rejectYes: 'Yes, reject',
      cancel: 'Cancel',
      sending: 'Saving the decision…',
      unknown:
        'We could not tell whether the decision was saved. Look at the change before you try again.',
      look: 'Look at the change',
      done: { APPROVE: 'The change was approved.', REJECT: 'The change was rejected.' },
    },
    mayNotDecide: 'A senior officer decides this.',
    selfApproval: 'A different officer decides a change you asked for.',
    loading: 'Loading the change…',
    notFound: 'This change could not be found.',
    stale: 'This change was decided or changed after you opened it. Reload to see it as it is now.',
  },

  // The closes that left work, found again on the next shift.
  closedExceptions: {
    title: 'Closed with parcels left',
    description:
      'Vendors that were closed while parcels received had no order. They are listed so that they are not lost.',
    tableLabel: 'Vendors closed with parcels still to order',
    viewsLabel: 'Views of the closed vendors',
    noun: { plural: 'closed vendors', one: 'closed vendor', other: 'closed vendors' },
    views: {
      all: { label: 'Still to order', none: 'No closed vendor has parcels still to order.' },
    },
    columns: {
      vendor: 'Vendor',
      closed: 'Closed',
      still: 'Still without an order',
      reason: 'Reason given',
    },
    notice:
      'Nothing here can add the missing orders yet. The parcels are listed so that they are not lost; a closed vendor cannot take more orders from this page.',
    facts: {
      closed: 'Closed',
      received: 'Received',
      ordered: 'Orders made',
      still: 'Still without an order',
      reason: 'Reason given',
      mode: 'How it was received',
    },
    modes: { PHOTO_CHECK_IN: 'Checked in against photos', BLIND_COUNT: 'Counted without photos' },
    /** The line under a closed vendor named by its vendor: its code, and how it was received (Run G1, Part 2, item 9). */
    modeLine: (code: string, how: string): string => `${code} · ${how}`,
    noReason: 'No reason was recorded.',
    acts: { openVendor: 'Open the vendor', openSummary: 'See the summary' },
    stillCount: (count: number): string => (count === 1 ? '1 parcel' : `${String(count)} parcels`),
  },

  // The vendors a hub has cleared for their orders.
  /** The service areas of the launch hub in the words of the floor (the master specification, section 23), and the two scopes an order's destination can have: a code the table has no words for is told in sentence case and never as its code. */
  areas: {
    ACCRA_TEMA: 'Accra & Tema',
    AMASAMAN_ENVIRONS: 'Amasaman & Environs',
    KASOA_CORRIDOR: 'Kasoa Corridor',
    SERVICE_AREA: 'In our service area',
    OUTSIDE_SERVICE_AREA: 'Outside our service area',
  },
  toMake: {
    title: 'Orders to make',
    description:
      'The vendors checked in at your hubs whose orders are not finished. Open one to make its orders.',
    tableLabel: 'Vendors with orders to make',
    viewsLabel: 'Views of the vendors',
    noun: { plural: 'vendors', one: 'vendor', other: 'vendors' },
    views: {
      READY_FOR_ITEMIZATION: {
        label: 'Ready to start',
        none: 'No vendor is waiting for its first order. Vendors whose orders are being made are under Being worked.',
      },
      ITEMIZING: {
        label: 'Being worked',
        none: 'No vendor has orders being made. Vendors waiting for their first order are under Ready to start.',
      },
      NEEDS_SENIOR: {
        label: 'Needs a senior',
        none: 'No vendor is waiting for a senior officer.',
      },
      // The vendors whose check-in is open (D-D6): the way in to the early orders, from the photos. Drafts.
      AWAITING_COUNT: {
        label: 'Being checked in',
        none: 'No vendor is being checked in against its photos.',
      },
    },
    columns: {
      vendor: 'Vendor',
      run: 'Run',
      received: 'Received',
      orders: 'Orders',
      why: 'Why a senior',
      handedOver: 'Handed over',
      /** The card of a vendor whose check-in is open names the act that starts its orders. */
      start: 'Orders',
    },
    /** What a row says of a vendor's orders, from the counts the list gives (the database's own): *3 made, 2 to make*. Nothing is said where the list gave none. */
    ordersLine: (made: number, left: number | null): string =>
      left === null ? `${String(made)} made` : `${String(made)} made, ${String(left)} to make`,
    senior: {
      ARRIVAL_TAKEN_BACK: 'An arrival was taken back. A senior officer reviews it.',
      decides: 'A senior officer decides.',
      review: 'Review the vendor',
    },
    received: (count: number | null): string => (count === null ? 'Not counted' : parcels(count)),
    /** How many of the parcels a vendor arrived with are here so far, while its check-in is open: *2 of 5 here*. */
    here: (here: number, expected: number): string => `${String(here)} of ${String(expected)} here`,
    missing: (count: number): string => `${String(count)} missing`,
    blind: 'Counted without photos',
    /** The line under a vendor counted without photos that is named by its vendor: its code, and how it was counted (Run G1, Part 2, item 9). */
    blindLine: (code: string): string => `${code} · Counted without photos`,
    acts: { open: 'Make orders', openFor: (vendor: string): string => `Make orders for ${vendor}` },
  },
} as const;

// ---- Refusals -----------------------------------------------------------------------------------------------------------------------------------

const OTHER_HUB = 'This vendor is at a hub your account does not work in.';
const VENDOR_NOT_FOUND = 'This vendor could not be found.';
const ORDER_NOT_FOUND = 'This order could not be found.';
const REFRESH = 'Check the price again to go on.';
const NOTE_REFUSED = 'Check the note marked below: it was not accepted as written.';
const STALE_LIST =
  'That page of the list could not be opened: its place in the list was not accepted. Go back to the first page to start again.';

const ORDER_OPERATIONS = [
  'previewOrder',
  'itemizeOrder',
  'previewOrderAmendment',
  'amendOrder',
] as const;

/** What a failure of each way of making or changing an order says when nothing more particular is known: what was and was not done, and never a diagnosis. */
const ORDER_FAILURE: Readonly<Record<(typeof ORDER_OPERATIONS)[number], string>> = {
  previewOrder: 'The price could not be checked. Nothing was saved.',
  previewOrderAmendment: 'The price could not be checked. Nothing was changed.',
  itemizeOrder: 'The order was not saved.',
  amendOrder: 'The change was not saved.',
};

/** The refusals every way of making or changing an order shares, in the words of the floor. */
const orderRefusals = (operation: (typeof ORDER_OPERATIONS)[number]): readonly CopyRule[] => [
  { operation, text: ORDER_FAILURE[operation] },
  { operation, code: 'PERMISSION_DENIED', text: cannotText('hub.intake.itemize') },
  {
    operation,
    code: 'NOT_FOUND',
    text:
      operation.includes('Amend') || operation === 'amendOrder'
        ? ORDER_NOT_FOUND
        : VENDOR_NOT_FOUND,
  },
  { operation, code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation,
    code: 'SIZE_CLASS_REQUIRED',
    text: 'Choose the size of the parcel. Nothing is chosen for you.',
  },
  {
    operation,
    code: 'VALUE_DECLARATION_REQUIRED',
    text: 'A value this high needs the sender’s agreement to the liability limit when the pickup is booked, and this booking has none. Check the declared value.',
  },
  {
    operation,
    code: 'REASON_REQUIRED',
    text: 'A high-value parcel needs photos of it. Add them to go on.',
  },
  {
    operation,
    code: 'EVIDENCE_NOT_STORED',
    text: 'A photo is not saved yet. Wait for it to finish, or add it again.',
  },
  {
    operation,
    code: 'CARRIER_COST_REQUIRED',
    text: 'Enter the carrier’s charge from the waybill and add a photo of the waybill.',
  },
  {
    operation,
    code: 'MARGIN_NOT_CONFIGURED',
    text: 'This hub has no margin set for parcels sent outside its area, so they cannot be priced here yet.',
  },
  {
    operation,
    code: 'SERVICE_DATE_NOT_PERMITTED',
    text: 'We do not deliver on that day. Choose another day.',
  },
  {
    operation,
    code: 'COMMITMENT_SOURCE_UNRESOLVED',
    text: 'The time the rider took the parcels cannot be found, so the order cannot be dated. Tell a senior officer.',
  },
  {
    operation,
    code: 'SETTING_MISSING',
    text: 'This hub has no price set for this order yet, so it cannot be priced.',
  },
  {
    operation,
    context: 'destination_zone_unresolved',
    code: 'SETTING_MISSING',
    text: 'The address does not match a zone of this hub, so the order cannot be priced. Add the area or a landmark to the address.',
  },
  {
    operation,
    context: 'destination_zone_ambiguous',
    code: 'VALIDATION_FAILED',
    text: 'The address matches more than one zone. Choose the right one.',
  },
  {
    operation,
    context: 'destination_zone_not_available',
    code: 'VALIDATION_FAILED',
    text: 'The zone you chose is not one this hub delivers to. Choose another.',
  },
  {
    operation,
    context: 'requested_before_default',
    code: 'VALIDATION_FAILED',
    text: 'That date is earlier than the first day we can deliver. Choose a later day.',
  },
  {
    operation,
    context: 'parcel_required',
    code: 'VALIDATION_FAILED',
    text: 'Choose the parcel this order is for.',
  },
  {
    operation,
    context: 'parcel_not_allowed',
    code: 'VALIDATION_FAILED',
    text: 'This vendor was counted without photos, so an order is not made for a parcel.',
  },
  {
    operation,
    context: 'unknown_parcel',
    code: 'VALIDATION_FAILED',
    text: 'That parcel is not one of this vendor’s. Go back to the orders and choose again.',
  },
  {
    operation,
    context: 'no_change',
    code: 'VALIDATION_FAILED',
    text: 'Nothing was changed. Change something, or go back.',
  },
  {
    operation,
    code: 'VALIDATION_FAILED',
    text: 'Some of what was entered was not accepted. Check the fields marked below.',
  },
  {
    operation,
    code: 'STATE_CONFLICT',
    text: 'The vendor is not as it was when you opened this. Check the price again to go on.',
  },
  {
    operation,
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: `This vendor changed while you were working. Your entries are kept. ${REFRESH}`,
  },
  {
    operation,
    context: 'terms_changed',
    code: 'STATE_CONFLICT',
    text: `The price or the terms changed while you were looking at them. ${REFRESH}`,
  },
  {
    operation,
    context: 'configuration_changing',
    code: 'STATE_CONFLICT',
    text: 'The hub’s prices are being changed at the moment, so nothing was saved. Check the price again in a moment.',
  },
  {
    operation,
    context: 'parcel_ordered',
    code: 'STATE_CONFLICT',
    text: 'This parcel already has an order. Open the orders to see it.',
  },
  {
    operation,
    context: 'parcel_missing',
    code: 'STATE_CONFLICT',
    text: 'This parcel is missing, so it cannot be ordered. If it is found, check it in first.',
  },
  {
    operation,
    context: 'parcel_void',
    code: 'STATE_CONFLICT',
    text: 'This parcel was taken back, so it has no order.',
  },
  {
    operation,
    context: 'orders_exceed_received',
    code: 'STATE_CONFLICT',
    text: 'Every parcel received already has an order.',
  },
  {
    operation,
    context: 'check_in_open',
    code: 'STATE_CONFLICT',
    text: 'The vendor is still being checked in. Finish the check-in first, or make the order for a parcel that is not here yet.',
  },
  {
    operation,
    context: 'check_in_finished',
    code: 'STATE_CONFLICT',
    text: 'The vendor’s check-in is final, so an order can no longer be made from a photo for a parcel that was not here. Open the orders to see where the parcel stands now.',
  },
  {
    operation,
    context: 'reconciliation_open',
    code: 'STATE_CONFLICT',
    text: 'The vendor is waiting for a senior officer to decide what to do about missing or damaged parcels. Orders can be made once that is done.',
  },
  {
    operation,
    context: 'intake_not_ready',
    code: 'STATE_CONFLICT',
    text: 'The vendor is not cleared for orders yet. Finish checking it in first.',
  },
  {
    operation,
    context: 'intake_closed',
    code: 'STATE_CONFLICT',
    text: 'The vendor is closed, so its orders cannot be changed.',
  },
  {
    operation,
    context: 'order_confirmed',
    code: 'STATE_CONFLICT',
    text: 'This order is confirmed, so it cannot be changed here. To change who pays, ask for a correction.',
  },
  {
    operation,
    context: 'price_frozen',
    code: 'STATE_CONFLICT',
    text: 'The price is already fixed, so this cannot be changed here. Ask for a correction instead.',
  },
  {
    operation,
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    text: 'This request clashed with an earlier attempt. Look at the orders before you try again.',
  },
];

export const ORDERS_COPY: readonly CopyRule[] = [
  // The worklist.
  { operation: 'listIntakeOrders', text: ORDERS_WORDS.workspace.problems.readOrders },
  { operation: 'listIntakeOrders', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  { operation: 'listIntakeOrders', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  { operation: 'listIntakeOrders', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'listIntakeOrders',
    code: 'VALIDATION_FAILED',
    text: 'That view was not accepted. Choose one of the views.',
  },
  {
    operation: 'listIntakeOrders',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: STALE_LIST,
  },

  // Making and changing an order.
  ...ORDER_OPERATIONS.flatMap(orderRefusals),

  // An order's page.
  { operation: 'getOrder', text: 'This order could not be loaded.' },
  { operation: 'getOrder', code: 'PERMISSION_DENIED', text: cannotText('pricing.read') },
  { operation: 'getOrder', code: 'NOT_FOUND', text: ORDER_NOT_FOUND },
  {
    operation: 'getOrder',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This order is at a hub your account does not work in.',
  },

  // Taking back an arrival.
  { operation: 'reverseOrderArrival', text: 'The arrival was not taken back.' },
  {
    operation: 'reverseOrderArrival',
    code: 'PERMISSION_DENIED',
    // What a senior officer decides is never answered with "ask an administrator" (OB-S1-111): the words say who does it.
    text: 'A senior officer takes back an arrival. Ask one to do it.',
  },
  { operation: 'reverseOrderArrival', code: 'NOT_FOUND', text: ORDER_NOT_FOUND },
  {
    operation: 'reverseOrderArrival',
    code: 'REASON_REQUIRED',
    text: 'Write why the arrival is being taken back.',
  },
  {
    operation: 'reverseOrderArrival',
    code: 'VALIDATION_FAILED',
    text: NOTE_REFUSED,
  },
  {
    operation: 'reverseOrderArrival',
    code: 'STATE_CONFLICT',
    text: 'This order is not as it was when you opened it, so nothing was changed. Reload to see it as it is now.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This order changed after you opened it, so nothing was changed. Reload to see it as it is now.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'order_not_confirmed',
    code: 'STATE_CONFLICT',
    text: 'This order is not confirmed yet, so there is no arrival to take back. Change the order instead.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'order_progressed',
    code: 'STATE_CONFLICT',
    text: 'This order has been paid for or reserved, so its arrival can no longer be taken back here.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'order_dispatched',
    code: 'STATE_CONFLICT',
    text: 'This order has gone out for delivery, so its arrival can no longer be taken back here.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'already_reversed',
    code: 'STATE_CONFLICT',
    text: 'The arrival of this order was already taken back.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'correction_open',
    code: 'STATE_CONFLICT',
    text: 'A change of who pays is waiting for a decision on this order. Decide it first.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'intake_closed',
    code: 'STATE_CONFLICT',
    text: 'The vendor is closed, so an arrival can no longer be taken back.',
  },
  {
    operation: 'reverseOrderArrival',
    context: 'blind_count_intake',
    code: 'STATE_CONFLICT',
    text: 'This vendor was counted without photos, so there is no parcel to take back.',
  },
  {
    operation: 'reverseOrderArrival',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This order is at a hub your account does not work in.',
  },

  // A parcel the officer is waiting on the vendor's details for (D-S7-12).
  { operation: 'setParcelWaitingForVendor', text: 'The mark was not saved.' },
  {
    operation: 'setParcelWaitingForVendor',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.itemize'),
  },
  {
    operation: 'setParcelWaitingForVendor',
    code: 'NOT_FOUND',
    text: 'This parcel could not be found.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    code: 'HUB_SCOPE_VIOLATION',
    text: OTHER_HUB,
  },
  { operation: 'setParcelWaitingForVendor', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
  {
    operation: 'setParcelWaitingForVendor',
    code: 'STATE_CONFLICT',
    text: 'This vendor is not as it was when you opened it, so nothing was changed. Reload to see it as it is now.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This vendor changed after you opened it, so nothing was changed. Reload to see it as it is now.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    context: 'parcel_ordered',
    code: 'STATE_CONFLICT',
    text: 'This parcel already has its order, so there is nothing to wait for.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    context: 'parcel_missing',
    code: 'STATE_CONFLICT',
    text: 'This parcel is missing, so nobody is waiting on the vendor for it.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    context: 'parcel_void',
    code: 'STATE_CONFLICT',
    text: 'This parcel was taken back, so there is nothing to wait for.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    context: 'reconciliation_open',
    code: 'STATE_CONFLICT',
    text: 'This vendor is in review until a senior officer decides. Mark the parcel afterwards.',
  },
  {
    operation: 'setParcelWaitingForVendor',
    context: 'intake_not_ready',
    code: 'STATE_CONFLICT',
    text: 'This vendor is not being checked in or ordered for now.',
  },

  // The recipient of a confirmed order, corrected (D-S7-1).
  { operation: 'correctOrderRecipient', text: 'The correction was not saved.' },
  {
    operation: 'correctOrderRecipient',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.itemize'),
  },
  { operation: 'correctOrderRecipient', code: 'NOT_FOUND', text: ORDER_NOT_FOUND },
  {
    operation: 'correctOrderRecipient',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This order is at a hub your account does not work in.',
  },
  {
    operation: 'correctOrderRecipient',
    code: 'REASON_REQUIRED',
    text: 'Write why you are correcting this.',
  },
  {
    operation: 'correctOrderRecipient',
    code: 'VALIDATION_FAILED',
    text: 'Check what is marked above: it was not accepted as written.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'no_change',
    code: 'VALIDATION_FAILED',
    text: 'Nothing was changed. Correct a detail, or cancel.',
  },
  {
    operation: 'correctOrderRecipient',
    code: 'STATE_CONFLICT',
    text: 'This order is not as it was when you opened it, so nothing was changed. Reload to see it as it is now.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This order changed after you opened it, so nothing was changed. Reload to see it as it is now.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'address_changes_zone',
    code: 'STATE_CONFLICT',
    text: 'That address is in another zone, so it would change the price. It cannot be corrected here yet, and nothing was changed.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'order_not_confirmed',
    code: 'STATE_CONFLICT',
    text: 'This order is not confirmed yet. Change it from its page instead.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'order_reversed',
    code: 'STATE_CONFLICT',
    text: 'The arrival of this order was taken back, so its recipient cannot be corrected.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'order_progressed',
    code: 'STATE_CONFLICT',
    text: 'This order has been paid for or reserved, so its recipient can no longer be corrected here.',
  },
  {
    operation: 'correctOrderRecipient',
    context: 'order_dispatched',
    code: 'STATE_CONFLICT',
    text: 'This order has gone out for delivery, so its recipient can no longer be corrected here.',
  },
  {
    operation: 'correctOrderRecipient',
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    text: 'This request clashed with an earlier attempt. Look at the order before you try again.',
  },

  // Who pays, after the price is fixed.
  { operation: 'requestPayerCorrection', text: 'The change was not asked for.' },
  {
    operation: 'requestPayerCorrection',
    code: 'PERMISSION_DENIED',
    text: cannotText('pricing.correction.create'),
  },
  { operation: 'requestPayerCorrection', code: 'NOT_FOUND', text: ORDER_NOT_FOUND },
  {
    operation: 'requestPayerCorrection',
    code: 'REASON_REQUIRED',
    text: 'Write why who pays should change.',
  },
  {
    operation: 'requestPayerCorrection',
    code: 'VALIDATION_FAILED',
    text: 'Check the fields marked below: they were not accepted as written.',
  },
  {
    operation: 'requestPayerCorrection',
    code: 'STATE_CONFLICT',
    text: 'This order is not as it was when you opened it, so nothing was asked for. Reload to see it as it is now.',
  },
  {
    operation: 'requestPayerCorrection',
    context: 'correction_open',
    code: 'STATE_CONFLICT',
    text: 'A change of who pays is already waiting for a decision on this order.',
  },
  {
    operation: 'requestPayerCorrection',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: 'This order changed after you opened it, so nothing was asked for. Reload to see it as it is now.',
  },
  {
    operation: 'requestPayerCorrection',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This order is at a hub your account does not work in.',
  },
  { operation: 'listPayerCorrections', text: 'The changes of who pays could not be loaded.' },
  {
    operation: 'listPayerCorrections',
    code: 'PERMISSION_DENIED',
    text: cannotText('pricing.correction.create'),
  },
  {
    operation: 'listPayerCorrections',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: STALE_LIST,
  },
  { operation: 'getPayerCorrection', text: 'This change could not be loaded.' },
  {
    operation: 'getPayerCorrection',
    code: 'PERMISSION_DENIED',
    text: cannotText('pricing.correction.create'),
  },
  { operation: 'getPayerCorrection', code: 'NOT_FOUND', text: ORDERS_WORDS.corrections.notFound },
  {
    operation: 'getPayerCorrection',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This change is at a hub your account does not work in.',
  },
  { operation: 'approvePayerCorrection', text: 'The decision was not saved.' },
  {
    operation: 'approvePayerCorrection',
    code: 'PERMISSION_DENIED',
    text: SENIOR_DECIDES,
  },
  {
    operation: 'approvePayerCorrection',
    code: 'NOT_FOUND',
    text: ORDERS_WORDS.corrections.notFound,
  },
  {
    operation: 'approvePayerCorrection',
    code: 'SELF_APPROVAL_FORBIDDEN',
    text: ORDERS_WORDS.corrections.selfApproval,
  },
  {
    operation: 'approvePayerCorrection',
    code: 'STATE_CONFLICT',
    text: 'This change was decided or changed after you opened it, so nothing was saved. Reload to see it as it is now.',
  },
  {
    operation: 'approvePayerCorrection',
    code: 'VALIDATION_FAILED',
    text: NOTE_REFUSED,
  },
  {
    operation: 'approvePayerCorrection',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This change is at a hub your account does not work in.',
  },

  // The close.
  { operation: 'getIntakeClosure', text: 'What closing finds could not be read.' },
  {
    operation: 'getIntakeClosure',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.close'),
  },
  { operation: 'getIntakeClosure', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  { operation: 'getIntakeClosure', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'closeHubIntake', text: 'The vendor was not closed.' },
  { operation: 'closeHubIntake', code: 'PERMISSION_DENIED', text: cannotText('hub.intake.close') },
  { operation: 'closeHubIntake', code: 'NOT_FOUND', text: VENDOR_NOT_FOUND },
  { operation: 'closeHubIntake', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'closeHubIntake',
    code: 'INSUFFICIENT_AUTHORITY',
    text: ORDERS_WORDS.close.exception.mustAsk,
  },
  {
    operation: 'closeHubIntake',
    code: 'REASON_REQUIRED',
    text: ORDERS_WORDS.close.exception.reasonRequired,
  },
  {
    operation: 'closeHubIntake',
    code: 'ORDER_UNPRICED',
    text: ORDERS_WORDS.close.blockers.order_unpriced,
  },
  {
    operation: 'closeHubIntake',
    code: 'PARITY_NOT_MET',
    text: 'Some parcels received still have no order. Make their orders, or a senior officer can close with a reason.',
  },
  {
    operation: 'closeHubIntake',
    code: 'VALIDATION_FAILED',
    text: 'The reason was not accepted as written. Check it and try again.',
  },
  {
    operation: 'closeHubIntake',
    context: 'exception_not_needed',
    code: 'VALIDATION_FAILED',
    text: 'Every parcel received has an order, so there is nothing to close with a reason. Read it again and close normally.',
  },
  {
    operation: 'closeHubIntake',
    code: 'STATE_CONFLICT',
    text: 'The vendor is not as it was when you read it, so it was not closed. Read it again.',
  },
  {
    operation: 'closeHubIntake',
    context: 'stale',
    code: 'STATE_CONFLICT',
    text: `${ORDERS_WORDS.close.stale.title}. ${ORDERS_WORDS.close.stale.text}`,
  },
  {
    operation: 'closeHubIntake',
    context: 'assessment_changed',
    code: 'STATE_CONFLICT',
    text: `${ORDERS_WORDS.close.changed.title}. ${ORDERS_WORDS.close.changed.text}`,
  },
  {
    operation: 'closeHubIntake',
    context: 'orders_exceed_received',
    code: 'STATE_CONFLICT',
    text: ORDERS_WORDS.close.blockers.orders_exceed_received,
  },
  {
    operation: 'closeHubIntake',
    context: 'check_in_open',
    code: 'STATE_CONFLICT',
    text: 'The vendor is still being checked in. Finish the check-in first.',
  },
  {
    operation: 'closeHubIntake',
    context: 'intake_not_counted',
    code: 'STATE_CONFLICT',
    text: 'The vendor has not been counted yet. Record the count first.',
  },
  {
    operation: 'closeHubIntake',
    context: 'reconciliation_open',
    code: 'STATE_CONFLICT',
    text: 'The vendor is waiting for a senior officer to decide what to do about missing or damaged parcels. Close it once that is done.',
  },
  {
    operation: 'closeHubIntake',
    context: 'already_closed',
    code: 'STATE_CONFLICT',
    text: 'This vendor is already closed.',
  },
  {
    operation: 'closeHubIntake',
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    text: 'This request clashed with an earlier attempt. Read the vendor again before you try again.',
  },
  { operation: 'getIntakeSummary', text: 'The summary could not be loaded.' },
  { operation: 'getIntakeSummary', code: 'PERMISSION_DENIED', text: cannotText('pickup.read') },
  { operation: 'getIntakeSummary', code: 'NOT_FOUND', text: ORDERS_WORDS.summary.notClosed },
  { operation: 'getIntakeSummary', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'listClosedIntakeExceptions', text: 'The closed vendors could not be loaded.' },
  {
    operation: 'listClosedIntakeExceptions',
    code: 'PERMISSION_DENIED',
    text: cannotText('hub.intake.close_exception'),
  },
  {
    operation: 'listClosedIntakeExceptions',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: STALE_LIST,
  },

  // The vendors a hub has cleared for their orders.
  { operation: 'listHubIntakes', text: 'The vendors could not be loaded.' },
  { operation: 'listHubIntakes', code: 'PERMISSION_DENIED', text: cannotText('hub.read') },
  {
    operation: 'listHubIntakes',
    code: 'VALIDATION_FAILED',
    text: 'That view was not accepted. Choose one of the views.',
  },
  { operation: 'listHubIntakes', context: 'cursor', code: 'VALIDATION_FAILED', text: STALE_LIST },
];

/** Every word the screens draw, for the test that holds each to the floor's voice (no key, no role, none of the words the floor does not use). */
export function everyOrdersWord(): readonly string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') found.push(value);
    else if (typeof value === 'function') {
      // A function of the words gives its text for sample figures: the test draws each with the ones it knows.
    } else if (typeof value === 'object' && value !== null) {
      for (const member of Object.values(value)) visit(member);
    }
  };
  visit(ORDERS_WORDS);
  for (const rule of ORDERS_COPY) found.push(rule.text);
  return found;
}
