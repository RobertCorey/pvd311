/**
 * Category registry — the launch set, mapped to Providence 311 case types.
 * GUIDs come from scripts/case-type-census-2026-08-21.json (live census).
 *
 * `fields` maps Step-3 control ids (cop_*) to a value source. Controls that are
 * visible on the portal but have no mapping here are handled by the agent scout
 * at submit time (see automation/src/scout.ts) — never pre-crawled.
 */
export type FieldSource = {
    from: string;
    default?: string;
} | {
    value: string;
};
export interface CategoryConfig {
    label: string;
    /** Exact case-type name as shown in the portal lookup (for logging / fallback search). */
    portalCaseTypeName: string;
    portalCaseTypeGuid: string;
    /** Wildcard search term that narrows the lookup modal to a page containing the GUID row. */
    portalSearchTerm: string;
    /** Request Type select (#casetypecode): '1' Question, '2' Problem, '3' Request, '585680001' Comment */
    requestType?: '1' | '2' | '3' | '585680001';
    /** Known Step-3 conditional fields for this case type. */
    fields?: Record<string, FieldSource>;
    /** Whether a photo is required before auto-submission (default true). */
    photoRequired?: boolean;
    /** Seasonal categories are hidden from the picker out of season. */
    seasonal?: 'winter';
}
export declare const CATEGORIES: Record<string, CategoryConfig>;
export type Category = keyof typeof CATEGORIES;
export declare function isCategory(x: unknown): x is Category;
/** Resolve a FieldSource against a report object. */
export declare function resolveField(src: FieldSource, report: Record<string, unknown>): string | undefined;
