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
  bedrooms: number | null; // CAMA NumBedRooms (unreliable on big buildings, but 0 beds + 0 baths = no dwelling space)
  bathrooms: number | null; // CAMA NumBathrooms (on apartment buildings this tracks the unit count)
  lastSaleDate: string | null; // ISO date

  // Derived
  /** Condo parcels only: how many condo units share this plat-lot (the building/association, roughly). */
  condoBuildingUnits: number | null;
  /** How many other residential parcels the same normalized owner name holds (low confidence). */
  ownerOtherResidentialParcels: number;
  ownerOtherResidential: { id: string; address: string; ownerOccupied: boolean | null }[];
  /** Dwelling units across all residential parcels under this owner's normalized name (incl. this one). */
  ownerPortfolioUnits: number;
  /** The normalized name covers 2+ owner-occupied parcels — several different people share it, so name matching is off. */
  ownerNameAmbiguous: boolean;
  /** The parcel at the owner's mailing address when that is a different Providence residential parcel (the owner's likely home). */
  homeParcelId: string | null;
  homeParcelAddress: string | null;
  homeParcelOwnerOccupied: boolean | null;
  /** Home parcel's owner normalizes to the same name as this parcel's owner. */
  homeParcelSameOwner: boolean | null;
  /** Latest permit for a new residential building or a conversion of nonresidential space into dwellings (2016–Mar 2024). */
  newUnitsPermit: { kind: 'new_residential' | 'conversion'; issued: string; units: number | null; record: string; description: string } | null;
  razePermitDate: string | null;
  /** Sum of stated project costs on building permits issued 2019-01 … 2024-03 (renovation intensity). */
  permitCostSince2019: number;
  /** Regulated-affordable signals: '8LAW' levy, HUD LIHTC / assisted multifamily / public housing, PHA site, housing-authority owner. */
  affordableSignals: string[];
}
