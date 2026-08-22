/**
 * Category registry — the launch set, mapped to Providence 311 case types.
 * GUIDs come from scripts/case-type-census-2026-08-21.json (live census).
 *
 * `fields` maps Step-3 control ids (cop_*) to a value source. Controls that are
 * visible on the portal but have no mapping here are handled by the agent scout
 * at submit time (see automation/src/scout.ts) — never pre-crawled.
 */
export const CATEGORIES = {
    pothole: {
        label: 'Pothole',
        portalCaseTypeName: 'Pothole Report',
        portalCaseTypeGuid: '5f0efb0b-0454-ef11-a317-001dd8068673',
        portalSearchTerm: '*Pothole*',
        fields: { cop_size: { from: 'extra.size', default: 'Unknown' } },
    },
    missed_trash: {
        label: 'Missed trash / recycling pickup',
        portalCaseTypeName: 'Missed Trash Day Pick-up Issue',
        portalCaseTypeGuid: '1ee8b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Missed Trash*',
        photoRequired: false,
    },
    bins_carts: {
        label: 'Trash / recycling bins or carts',
        portalCaseTypeName: 'Trash or Recycling Bins or Carts',
        portalCaseTypeGuid: '36e8b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Bins or Carts*',
        // Radio group: "I did not receive my new carts." | "My old carts were not removed" | "Other"
        fields: { cop_cartrequesttype: { from: 'extra.cartIssue', default: 'Other' } },
        photoRequired: false,
    },
    street_light: {
        label: 'Street light out',
        portalCaseTypeName: 'Report Street Light Issue',
        portalCaseTypeGuid: 'd0e7b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Street Light*',
        photoRequired: false,
    },
    illegal_dumping: {
        label: 'Illegal dumping',
        portalCaseTypeName: 'Illegal Dumping',
        portalCaseTypeGuid: '00e8b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Illegal Dumping*',
    },
    abandoned_vehicle: {
        label: 'Abandoned vehicle',
        portalCaseTypeName: 'Abandoned Vehicle to Report',
        portalCaseTypeGuid: 'bce7b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Abandoned Vehicle*',
        fields: { cop_vehicledetails: { from: 'extra.vehicleDetails', default: 'See description and photo' } },
    },
    parking: {
        label: 'Parking problem',
        portalCaseTypeName: 'Parking Issues to Report',
        portalCaseTypeGuid: '30e8b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Parking Issues*',
    },
    animal_control: {
        label: 'Animal control',
        portalCaseTypeName: 'Animal Control Concerns',
        portalCaseTypeGuid: '630efb0b-0454-ef11-a317-001dd8068673',
        portalSearchTerm: '*Animal Control*',
        fields: { cop_typeofanimal: { from: 'extra.animalType', default: 'Wildlife' } },
        photoRequired: false,
    },
    noise: {
        label: 'Noise complaint',
        portalCaseTypeName: 'Noise or Sound Disturbances',
        portalCaseTypeGuid: '18e8b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*Noise*',
        photoRequired: false,
        // conditional fields (e.g. "Where is the noise from") are handled by the agent scout until mapped
    },
    unshoveled_sidewalk: {
        label: 'Unshoveled sidewalk',
        portalCaseTypeName: 'Report Un-shoveled Sidewalks',
        portalCaseTypeGuid: 'b8e7b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*shoveled*',
        seasonal: 'winter',
    },
    missed_plowing: {
        label: 'Street not plowed',
        portalCaseTypeName: 'Snow Plowing or Salting or Sanding Request',
        portalCaseTypeGuid: '5ae8b671-7a2e-ef11-840a-001dd8039400',
        portalSearchTerm: '*plowing*',
        seasonal: 'winter',
    },
    unsure: {
        label: 'Something else',
        portalCaseTypeName: 'I am unsure or do not know how to classify my request.',
        portalCaseTypeGuid: '5c006794-b08c-ef11-ac21-001dd804e2ae',
        portalSearchTerm: '*unsure*',
        photoRequired: false,
    },
};
export function isCategory(x) {
    return typeof x === 'string' && x in CATEGORIES;
}
/** Resolve a FieldSource against a report object. */
export function resolveField(src, report) {
    if ('value' in src)
        return src.value;
    const v = src.from.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), report);
    if (typeof v === 'string' && v.trim())
        return v;
    if (typeof v === 'number')
        return String(v);
    return src.default;
}
