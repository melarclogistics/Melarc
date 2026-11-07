import { describe, expect, it } from 'vitest';

import { dateFromText } from './date-value';
import {
  DAY_FIRST_MESSAGES,
  dayFirstPartAt,
  formatDayFirst,
  maskDayFirst,
  noSuchDayMessage,
  readDayFirst,
  stepDayFirst,
} from './day-first';

describe('formatDayFirst', () => {
  // Break caught: a date shown in another order, or without the zeros that keep the field the same width as it is typed.
  it('writes a date day first with two digits for the day and the month and four for the year', () => {
    expect(formatDayFirst(dateFromText('2026-10-08'))).toBe('08/10/2026');
    expect(formatDayFirst(dateFromText('0026-01-05'))).toBe('05/01/0026');
    expect(formatDayFirst(dateFromText('2028-02-29'))).toBe('29/02/2028');
  });

  // Break caught: no date written as a text ("00/00/0000", "null" or "Invalid Date" in the field).
  it('writes none as nothing', () => {
    expect(formatDayFirst(null)).toBe('');
  });
});

describe('readDayFirst', () => {
  // Break caught: a text read as a date it does not say: the day and the month the wrong way round, a century guessed, a day the month does not have.
  it.each([
    ['28/10/2026', 2026, 10, 28],
    ['01/01/2026', 2026, 1, 1],
    ['29/02/2028', 2028, 2, 29],
    ['31/12/9999', 9999, 12, 31],
    ['05/01/0026', 26, 1, 5],
  ])('reads %s as the date it says', (text, year, month, day) => {
    const reading = readDayFirst(text);

    expect(reading?.ok).toBe(true);
    if (reading?.ok !== true) return;
    expect([reading.date.year, reading.date.month, reading.date.day]).toEqual([year, month, day]);
  });

  // Break caught: a text that is not written DD/MM/YYYY accepted as a date, by any of the ways people write one.
  it.each([
    '2026-10-28',
    '28-10-2026',
    '28.10.2026',
    '28 10 2026',
    '28/10/20266',
    '8/10/2026',
    '28/1/2026',
    '28/10',
    '28/',
    '28',
    ' 28/10/2026',
    '28/10/2026 ',
    '28/10/2026\n',
    '２８/１０/２０２６',
    'tomorrow',
  ])('says %j is not written as DD/MM/YYYY', (text) => {
    expect(readDayFirst(text)).toEqual({
      ok: false,
      problem: 'shape',
      message: DAY_FIRST_MESSAGES.shape,
    });
  });

  // Break caught: a year of fewer than four digits read as the year it is not (26 as the year 26, or as 2026), or told to the person as a fault of the whole date.
  it.each(['28/10/26', '28/10/2', '28/10/202', '31/11/26', '30/02/26', '00/00/0'])(
    'refuses %s for its year, which has fewer than four digits, before anything else is said of it',
    (text) => {
      expect(readDayFirst(text)).toEqual({
        ok: false,
        problem: 'year',
        message: 'Enter the year in full, for example 2026',
      });
    },
  );

  // Break caught: a day that its month does not have moved to one that it does (30 February read as the 28th), accepted for the shape alone, or refused in words that do not
  // name the day and the month the person typed. The 29th of February of a year that is not a leap year names the year (the Product Owner's decision of 7 November 2026,
  // afternoon): `2027 has no 29 February`, in the year as it was typed (four digits), and a year that only looks like a leap year (1900, 2100: not divisible by 400) is named too.
  it.each([
    ['30/02/2026', 'There is no 30 February'],
    ['31/02/2026', 'There is no 31 February'],
    ['29/02/2027', '2027 has no 29 February'],
    ['29/02/2026', '2026 has no 29 February'],
    ['29/02/2100', '2100 has no 29 February'],
    ['29/02/1900', '1900 has no 29 February'],
    ['29/02/0100', '0100 has no 29 February'],
    ['30/02/2027', 'There is no 30 February'],
    ['30/02/2028', 'There is no 30 February'],
    ['31/04/2026', 'There is no 31 April'],
    ['31/06/2026', 'There is no 31 June'],
    ['31/09/2026', 'There is no 31 September'],
    ['31/11/2026', 'There is no 31 November'],
  ])('refuses %s, a day that its month does not have, and says %j', (text, message) => {
    expect(readDayFirst(text)).toEqual({ ok: false, problem: 'no-such-day', message });
  });

  // Break caught: a day that is not on the calendar at all (the 0th, the 32nd, a month 13, the year 0) told as a day that its month does not have, or accepted for the shape alone.
  it.each([
    '00/10/2026',
    '28/00/2026',
    '28/13/2026',
    '32/01/2026',
    '45/10/2026',
    '10/28/2026',
    '01/01/0000',
  ])('says %j is not a day on the calendar', (text) => {
    expect(readDayFirst(text)).toEqual({
      ok: false,
      problem: 'calendar',
      message: DAY_FIRST_MESSAGES.calendar,
    });
  });

  // Break caught: the 29th of February refused in a leap year (2000 is one: it is divisible by 400), or the last day of a month refused.
  it.each([
    '29/02/2028',
    '29/02/2024',
    '29/02/2000',
    '31/01/2026',
    '30/04/2026',
    '28/02/2027',
    '31/12/2026',
  ])('reads %s, a last day, as a date', (text) => {
    expect(readDayFirst(text)?.ok).toBe(true);
  });

  // Break caught: an empty field read as a mistake, which would shout at a person who has not begun.
  it('does not read an empty text at all', () => {
    expect(readDayFirst('')).toBeUndefined();
  });

  // Break caught: a message for a mistake in a developer's words ("invalid input", "parse error", "ISO format") or one too long to read at a glance under a field.
  it('has words for each way a text can be wrong, in plain terms and without a technical word', () => {
    for (const message of [
      ...Object.values(DAY_FIRST_MESSAGES),
      noSuchDayMessage(31, 11, 2026),
      noSuchDayMessage(29, 2, 2027),
    ]) {
      expect(message).not.toMatch(/regex|format string|ISO|parse|invalid input/i);
      expect(message.length).toBeLessThan(80);
    }
  });

  // Break caught: the words the Product Owner chose for the refusals of 7 November 2026 changed (a full stop added, a word changed), which a screen reader and a person would
  // meet, and which the tests of the pages that show them look for; or the year named for a day that is not the 29th of February, or left out of the 29th.
  it('refuses with the words the Product Owner chose', () => {
    expect(DAY_FIRST_MESSAGES.year).toBe('Enter the year in full, for example 2026');
    expect(noSuchDayMessage(30, 2, 2026)).toBe('There is no 30 February');
    expect(noSuchDayMessage(31, 4, 2027)).toBe('There is no 31 April');
    expect(noSuchDayMessage(29, 2, 2027)).toBe('2027 has no 29 February');
  });
});

describe('maskDayFirst', () => {
  /** Types a text one character at a time, as a person does, and gives what the field holds at the end. */
  function typed(text: string): string {
    let field = '';
    for (const character of text) field = maskDayFirst(field, field + character);
    return field;
  }

  // Break caught: slashes left for the person to type, or put in the wrong place.
  it.each([
    ['2', '2'],
    ['28', '28/'],
    ['281', '28/1'],
    ['2810', '28/10/'],
    ['28102', '28/10/2'],
    ['28102026', '28/10/2026'],
    ['28/10/2026', '28/10/2026'],
    ['2/', '02/'],
    ['3/11/2026', '03/11/2026'],
    ['28/1/', '28/01/'],
  ])('types %j as %j', (keys, result) => {
    expect(typed(keys)).toBe(result);
  });

  // Break caught: a field that takes more than a date, or something that is not a digit or a slash.
  it('takes digits and slashes only and no more than ten characters', () => {
    expect(typed('ab28cd/10/2026999')).toBe('28/10/2026');
    expect(typed('//28')).toBe('28/');
    expect(typed('28//10')).toBe('28/10/');
  });

  // Break caught: Backspace that puts the slash back, so that a person can never take it away.
  it('leaves what a person took away as they left it', () => {
    expect(maskDayFirst('28/', '28')).toBe('28');
    expect(maskDayFirst('28/10/', '28/10')).toBe('28/10');
    expect(maskDayFirst('28/10/2026', '28/10/202')).toBe('28/10/202');
    expect(maskDayFirst('28/10/2026', '28/0/2026')).toBe('28/0/2026');
    expect(maskDayFirst('28/10/2026', '')).toBe('');
  });

  // Break caught: a part cleared by Backspace that closes up (the day taken out of 28/10/2026 leaving 10/2026, or the year sliding into the month), so that the digits the person
  // did not touch change place and the date they are editing is another one.
  it('keeps a part that was cleared where it was, and the others with it', () => {
    expect(maskDayFirst('2/10/2026', '/10/2026')).toBe('/10/2026');
    expect(maskDayFirst('28/1/2026', '28//2026')).toBe('28//2026');
    expect(maskDayFirst('28/10/2026', '28/10/')).toBe('28/10/');
  });

  // Break caught: the first digit typed into a part that was cleared padded with a zero as if it were a part ended by a slash (2 typed into a cleared day becoming 02, so that 28 cannot
  // be typed), or the digits of a cleared part not put back one at a time.
  it('lets a cleared part be typed again, a digit at a time', () => {
    expect(maskDayFirst('/10/2026', '2/10/2026')).toBe('2/10/2026');
    expect(maskDayFirst('2/10/2026', '28/10/2026')).toBe('28/10/2026');
    expect(maskDayFirst('28//2026', '28/1/2026')).toBe('28/1/2026');
    expect(maskDayFirst('28/1/2026', '28/10/2026')).toBe('28/10/2026');
  });

  // Break caught: a slash typed after a single digit not padding it, or padding it where the slash was not just typed.
  it('pads a part typed in one digit when the slash is typed after it, and only then', () => {
    expect(maskDayFirst('2', '2/')).toBe('02/');
    expect(maskDayFirst('02/1', '02/1/')).toBe('02/01/');
    expect(maskDayFirst('', '3/11/2026', true)).toBe('03/11/2026');
    expect(maskDayFirst('', '28/1/2026', true)).toBe('28/01/2026');
  });

  // Break caught: a whole date pasted as digits not read as one.
  it('puts the slashes into digits pasted at once', () => {
    expect(maskDayFirst('', '28102026', true)).toBe('28/10/2026');
    expect(maskDayFirst('', '28/10/2026', true)).toBe('28/10/2026');
  });

  // Break caught: a date in another form turned into a different date by the mask (2026-10-28 into 20/26/1028) instead of being refused by the reading.
  it('keeps a paste that holds anything else as it was pasted, so that the reading can refuse it', () => {
    expect(maskDayFirst('', '2026-10-28', true)).toBe('2026-10-28');
    expect(maskDayFirst('', '28.10.2026', true)).toBe('28.10.2026');
    expect(maskDayFirst('', ' 28-10-2026 ', true)).toBe('28-10-2026');
    expect(readDayFirst(maskDayFirst('', '2026-10-28', true))).toEqual({
      ok: false,
      problem: 'shape',
      message: DAY_FIRST_MESSAGES.shape,
    });
  });
});

describe('dayFirstPartAt', () => {
  // Break caught: a step of the arrow keys that changes the wrong part (the month when the caret is in the day, the year when it is in the month).
  it.each([
    [0, 'day'],
    [1, 'day'],
    [2, 'day'],
    [3, 'month'],
    [4, 'month'],
    [5, 'month'],
    [6, 'year'],
    [10, 'year'],
  ] as const)('puts a caret at %i in the %s', (position, part) => {
    expect(dayFirstPartAt(position)).toBe(part);
  });
});

describe('stepDayFirst', () => {
  const step = (text: string, part: 'day' | 'month' | 'year', direction: 1 | -1): string => {
    const date = dateFromText(text);
    if (date === null) throw new Error(`${text} is not a date`);
    return stepDayFirst(date, part, direction).toString();
  };

  // Break caught: a day that steps out of its month (the 31st up is the 32nd, the 1st down is the 0th), so that the field gives a date that does not exist.
  it('steps the day and goes round within its month', () => {
    expect(step('2026-10-28', 'day', 1)).toBe('2026-10-29');
    expect(step('2026-10-28', 'day', -1)).toBe('2026-10-27');
    expect(step('2026-10-31', 'day', 1)).toBe('2026-10-01');
    expect(step('2026-10-01', 'day', -1)).toBe('2026-10-31');
    expect(step('2026-02-28', 'day', 1)).toBe('2026-02-01');
    expect(step('2028-02-28', 'day', 1)).toBe('2028-02-29');
    expect(step('2028-02-01', 'day', -1)).toBe('2028-02-29');
  });

  // Break caught: a month that steps to the 13th, or keeps a day the new month does not have (the 31st of November).
  it('steps the month and goes round the year, keeping the day or the last day of a shorter month', () => {
    expect(step('2026-10-28', 'month', 1)).toBe('2026-11-28');
    expect(step('2026-10-28', 'month', -1)).toBe('2026-09-28');
    expect(step('2026-12-15', 'month', 1)).toBe('2026-01-15');
    expect(step('2026-01-15', 'month', -1)).toBe('2026-12-15');
    expect(step('2026-10-31', 'month', 1)).toBe('2026-11-30');
    expect(step('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(step('2028-01-31', 'month', 1)).toBe('2028-02-29');
  });

  // Break caught: a year that steps past the ends of the calendar, or keeps the 29th of February in a year that has none.
  it('steps the year between 1 and 9999, keeping the day or the last day of February', () => {
    expect(step('2026-10-28', 'year', 1)).toBe('2027-10-28');
    expect(step('2026-10-28', 'year', -1)).toBe('2025-10-28');
    expect(step('2028-02-29', 'year', 1)).toBe('2029-02-28');
    expect(step('9999-12-31', 'year', 1)).toBe('9999-12-31');
    expect(step('0001-01-01', 'year', -1)).toBe('0001-01-01');
  });
});
