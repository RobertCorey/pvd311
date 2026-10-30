import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Parcel } from './types.ts';

export const DB_PATH = join(import.meta.dirname, '..', 'data', 'parcels.sqlite');
const JSON_COLS = ['affordableSignals', 'ownerOtherResidential'] as const;
const BOOL_COLS = ['ownerOccupiedTaxRate', 'mailingIsProperty', 'camaMatched', 'homeParcelOwnerOccupied', 'homeParcelSameOwner'] as const;

export function rowToParcel(row: Record<string, any>): Parcel {
  const p: any = { ...row };
  for (const k of JSON_COLS) p[k] = JSON.parse(p[k] ?? '[]');
  for (const k of BOOL_COLS) p[k] = p[k] == null ? null : !!p[k];
  return p as Parcel;
}

export function loadParcels(where = '1=1'): Parcel[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return (db.prepare(`SELECT * FROM parcels WHERE ${where}`).all() as Record<string, any>[]).map(rowToParcel);
  } finally {
    db.close();
  }
}
