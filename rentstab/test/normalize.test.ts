import { describe, expect, it } from 'vitest';
import { mailingStreetAndCity, ownerKey, ownerKind, parseAddress, sameAddress } from '../src/normalize.ts';

describe('parseAddress / sameAddress', () => {
  it('parses ranges and drops suffixes', () => {
    expect(parseAddress('31-33 Douglas Ave')).toEqual({ lo: 31, hi: 33, street: 'douglas' });
    expect(parseAddress('135 Brook Street Unit 2')).toEqual({ lo: 135, hi: 135, street: 'brook' });
    expect(parseAddress('PO BOX 40247')).toBeNull();
  });
  it('a 2-family at 13-15 matches a mailing address of 15', () => {
    expect(sameAddress(parseAddress('13-15 Payton St'), parseAddress('15 Payton Street'))).toBe(true);
    expect(sameAddress(parseAddress('13 Payton St'), parseAddress('17 Payton St'))).toBe(false);
    expect(sameAddress(parseAddress('13 Payton St'), parseAddress('13 Peyton St'))).toBe(false);
  });
});

describe('mailingStreetAndCity', () => {
  it('finds the street above the city line, skipping a trust-name line', () => {
    expect(mailingStreetAndCity(['Lederer Living Trust', '3 Constitution Hill St', 'Providence RI  02904', null]))
      .toEqual({ street: '3 Constitution Hill St', city: 'Providence RI  02904' });
    expect(mailingStreetAndCity(['PO BOX 40247', 'NULL', 'PROVIDENCE RI  02940', null]))
      .toEqual({ street: 'PO BOX 40247', city: 'PROVIDENCE RI  02940' });
    expect(mailingStreetAndCity(['16 Maria Ave', 'Providence  02919', null])).toEqual({ street: '16 Maria Ave', city: 'Providence  02919' });
    expect(mailingStreetAndCity(['4877 BROADWAY', 'APT 3J', 'NEW YORK NY  100343160'])).toEqual({ street: 'APT 3J', city: 'NEW YORK NY  100343160' });
  });
});

describe('owner names', () => {
  it('kinds', () => {
    expect(ownerKind('Rachel Barrett')).toBe('person');
    expect(ownerKind('Stephen Lederer Trustee')).toBe('trust');
    expect(ownerKind('Ananiarubino Enterprises, LLC')).toBe('entity');
    expect(ownerKind('')).toBe('unknown');
  });
  it('order-insensitive key on last + first name', () => {
    expect(ownerKey('Houle, Michael David')).toBe(ownerKey('Michael D Houle'));
    expect(ownerKey('Robert E Leahey JR')).toBe(ownerKey('Robert Leahey'));
    expect(ownerKey('A Smith & B Jones')).toBe(ownerKey('A Smith'));
    expect(ownerKey('02908 Holdco LLC')).toBe('entity:02908 holdco llc');
  });
});
