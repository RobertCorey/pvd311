import type { OwnerKind } from './normalize.ts';

/** One tax parcel, normalized from the FY2026 tax roll + the assessor (CAMA) layer + affordable-housing lists. */
export interface Parcel {
  id: string; // plat-lot-unit as on the roll, e.g. "016-0194-0000"
  address: string;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;

  // Tax roll (FY2026, assessment date 12/31/2024)
  taxClass: string; // roll CLASS, e.g. "2"
  taxClassDesc: string; // "2-5 Family"
  levyCode: string; // LEVY_CODE_1, e.g. "OO2-5"
  levyCode2: string | null; // second levy code on mixed-use parcels
  /** true = owner-occupied tax rate (OO01/OO2-5, homestead on file), false = non-owner-occupied rate, null = class has no such split. */
  ownerOccupiedTaxRate: boolean | null;
  owner: string;
  ownerKind: OwnerKind;
  ownerKey: string | null;
  mailingStreet: string | null;
  mailingCity: string | null;
  /** Owner's mailing address is this parcel (same street, overlapping house numbers, Providence). */
  mailingIsProperty: boolean | null;
  totalAssessment: number | null;
  totalExempt: number | null;

  // Assessor CAMA (roll year 2024)
  camaMatched: boolean;
  units: number | null; // NumUnits; null when missing or 0
  yearBuilt: number | null; // null when missing or 0
  useCode: string | null; // MuniUseCode
  useDesc: string | null;
  numBuildings: number | null;
  lastSaleDate: string | null; // ISO date

  // Derived
  /** Condo parcels only: how many condo units share this plat-lot (the building/association, roughly). */
  condoBuildingUnits: number | null;
  /** How many other residential parcels the same normalized owner name holds (low confidence). */
  ownerOtherResidentialParcels: number;
  ownerOtherResidentialIds: string[];
  /** Regulated-affordable signals: '8LAW' levy, HUD LIHTC / assisted multifamily / public housing, PHA site, housing-authority owner. */
  affordableSignals: string[];
}
