/**
 * Category registry — every REPORTABLE Providence 311 case type (the ~35 inquiry types such as
 * tax/vital-records/job-training are left out), mapped by GUID. GUIDs come from
 * scripts/case-type-census-2026-08-21.json (live census); the daily type-list crawl (engine.ts)
 * alerts when the portal adds, renames or drops one.
 *
 * The picker is DERIVED from the tags here (app/src/lib/categories.ts), browse-then-disambiguate:
 *   level 1  group tile (icon)            — `group`
 *   level 2  object row (text)            — `object` (default: the key); siblings that differ only
 *                                           by WHERE / WHO OWNS it collapse into one row
 *   level 3  one facet question (cards)   — `facet` { q, a } picks the exact city type
 * plus a search box over labels + `synonyms` + the city's own name. Rows sort by `demand`
 * (citywide public feed, Sep 21–28 2026, requests/week). Labels and synonyms are i18n'd in the app
 * (cat.<key>.short / .syn, obj.<object>, facet.<q> / facet.<q>.<a>); `label` here is the portal-facing
 * English used in emails and admin.
 *
 * `fields` maps Step-3 control ids (cop_*) to a value source. Controls that are visible on the
 * portal but have no mapping here are handled by the agent scout at submit time (worker/src/scout.ts)
 * — never pre-crawled.
 */

export type FieldSource =
  | { from: string; default?: string }   // dotted path into the report, e.g. "extra.size"
  | { value: string };                    // constant

/** Level-1 picker groups, in tile order (demand). `other` is the wide "Not sure" tile. */
export type GroupKey = 'trash' | 'streets' | 'traffic' | 'trees' | 'property' | 'lights' | 'nuisance' | 'water' | 'animals' | 'other';
export const GROUP_ORDER: GroupKey[] = ['trash', 'streets', 'traffic', 'trees', 'property', 'lights', 'nuisance', 'water', 'animals', 'other'];
/** "Something else in this group" files as this type (else `unsure`). DPW runs streets AND sanitation. */
export const GROUP_CATCH_ALL: Partial<Record<GroupKey, string>> = { trash: 'dpw_general', streets: 'dpw_general' };

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
  /** Picker group (level 1). */
  group: GroupKey;
  /** Level-2 row this type sits under when several city types differ only by a facet (default: the key). */
  object?: string;
  /** The facet answer that distinguishes this type among its object's siblings (level 3). */
  facet?: { q: string; a: string };
  /** English search synonyms (Spanish ones live in i18n cat.<key>.syn). */
  synonyms?: string[];
  /** Citywide requests/week (public feed Sep 21–28 2026) — row sort order. */
  demand?: number;
  /** Hidden from browse (reachable via GROUP_CATCH_ALL / the Not-sure tile only). */
  hidden?: boolean;
}

export const CATEGORIES: Record<string, CategoryConfig> = {
  pothole: {
    group: 'streets', demand: 9, synonyms: ['hole in the road', 'road damage'],
    label: 'Pothole',
    portalCaseTypeName: 'Pothole Report',
    portalCaseTypeGuid: '5f0efb0b-0454-ef11-a317-001dd8068673',
    portalSearchTerm: '*Pothole*',
    fields: { cop_size: { from: 'extra.size', default: 'Unknown' } },
  },
  missed_trash: {
    group: 'trash', demand: 27, synonyms: ['garbage not picked up', 'recycling not collected', 'skipped pickup'],
    label: 'Missed trash / recycling pickup',
    portalCaseTypeName: 'Missed Trash Day Pick-up Issue',
    portalCaseTypeGuid: '1ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Missed Trash*',
    photoRequired: false,
  },
  bins_carts: {
    group: 'trash', demand: 21, synonyms: ['new cart', 'broken cart', 'cart wheel', 'recycling bin'],
    label: 'Trash / recycling bins or carts',
    portalCaseTypeName: 'Trash or Recycling Bins or Carts',
    portalCaseTypeGuid: '36e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Bins or Carts*',
    // Radio group: "I did not receive my new carts." | "My old carts were not removed" | "Other"
    fields: { cop_cartrequesttype: { from: 'extra.cartIssue', default: 'Other' } },
    photoRequired: false,
  },
  street_light: {
    group: 'lights', demand: 4, synonyms: ['lamp out', 'light flickering', 'dark street', 'streetlight'],
    label: 'Street light out or flickering',
    portalCaseTypeName: 'Report Street Light Issue',
    portalCaseTypeGuid: 'd0e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Street Light*',
    photoRequired: false,
  },
  illegal_dumping: {
    group: 'trash', demand: 14, synonyms: ['dumped mattress', 'dumped tires', 'junk pile', 'construction debris'],
    label: 'Illegal dumping',
    portalCaseTypeName: 'Illegal Dumping',
    portalCaseTypeGuid: '00e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Illegal Dumping*',
  },
  abandoned_vehicle: {
    group: 'traffic', demand: 5, synonyms: ['abandoned car', 'junk car', 'car with no plates'],
    label: 'Abandoned vehicle',
    portalCaseTypeName: 'Abandoned Vehicle to Report',
    portalCaseTypeGuid: 'bce7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Abandoned Vehicle*',
    fields: { cop_vehicledetails: { from: 'extra.vehicleDetails', default: 'See description and photo' } },
  },
  parking: {
    group: 'traffic', demand: 15, synonyms: ['blocked driveway', 'parked on sidewalk', 'parked at hydrant', 'double parked'],
    label: 'Parking problem',
    portalCaseTypeName: 'Parking Issues to Report',
    portalCaseTypeGuid: '30e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Parking Issues*',
  },
  animal_control: {
    group: 'animals', demand: 2, synonyms: ['loose dog', 'stray', 'raccoon', 'coyote', 'barking'],
    label: 'Animal control',
    portalCaseTypeName: 'Animal Control Concerns',
    portalCaseTypeGuid: '630efb0b-0454-ef11-a317-001dd8068673',
    portalSearchTerm: '*Animal Control*',
    fields: { cop_typeofanimal: { from: 'extra.animalType', default: 'Wildlife' } },
    photoRequired: false,
  },
  noise: {
    group: 'nuisance', demand: 5, synonyms: ['loud music', 'loud party', 'construction noise'],
    label: 'Noise complaint',
    portalCaseTypeName: 'Noise or Sound Disturbances',
    portalCaseTypeGuid: '18e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Noise*',
    photoRequired: false,
    // conditional fields (e.g. "Where is the noise from") are handled by the agent scout until mapped
  },
  graffiti: {
    group: 'property', object: 'graffiti', facet: { q: 'where3', a: 'city' }, demand: 0, synonyms: ['tag', 'spray paint', 'vandalism'],
    label: 'Graffiti',
    portalCaseTypeName: 'Graffiti on City-Owned Property',
    portalCaseTypeGuid: '92e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Graffiti on City*',
  },
  sidewalk_repair: {
    group: 'streets', object: 'sidewalk', facet: { q: 'sidewalkCause', a: 'other' }, demand: 9, synonyms: ['cracked sidewalk', 'uneven sidewalk', 'trip hazard', 'broken curb'],
    label: 'Broken or uneven sidewalk',
    portalCaseTypeName: 'Sidewalk Panel Repair',
    portalCaseTypeGuid: '54e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Sidewalk Panel Repair*',
  },
  tree: {
    group: 'trees', demand: 33, synonyms: ['fallen branch', 'dead tree', 'limb down', 'prune', 'stump'],
    label: 'Tree problem',
    portalCaseTypeName: 'Tree Related Issue(s)',
    portalCaseTypeGuid: '070b1e94-b7f3-ef11-be20-001dd804ed86',
    portalSearchTerm: '*Tree Related*',
    // conditional field (Tree Work: Prune/Remove/...) handled by the scout until mapped
  },
  street_flooding: {
    group: 'streets', demand: 0, synonyms: ['flooded street', 'standing water', 'puddle'],
    label: 'Street flooding',
    portalCaseTypeName: 'Report Street Flooding',
    portalCaseTypeGuid: '64e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Street Flooding*',
  },
  traffic_signal: {
    group: 'traffic', demand: 4, synonyms: ['stoplight', 'red light out', 'walk signal', 'traffic light'],
    label: 'Traffic signal broken',
    portalCaseTypeName: 'Traffic Signal Malfunction',
    portalCaseTypeGuid: 'b1c3d9d8-cd3f-ef11-8409-001dd800f706',
    portalSearchTerm: '*Traffic Signal*',
    photoRequired: false,
    // conditional select (cop_trafficlightissue) handled by the scout until mapped
  },
  dead_animal: {
    group: 'animals', demand: 2, synonyms: ['roadkill', 'dead cat', 'dead squirrel'],
    label: 'Dead animal',
    portalCaseTypeName: 'Dead Animal on Roadway or Sidewalk',
    portalCaseTypeGuid: '4ce8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Dead Animal*',
    photoRequired: false,
  },
  unshoveled_sidewalk: {
    group: 'streets', demand: 0, synonyms: ['snow on sidewalk', 'icy sidewalk', 'not shoveled'],
    label: 'Unshoveled sidewalk',
    portalCaseTypeName: 'Report Un-shoveled Sidewalks',
    portalCaseTypeGuid: 'b8e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*shoveled*',
    seasonal: 'winter',
  },
  missed_plowing: {
    group: 'streets', demand: 0, synonyms: ['snow', 'plow', 'salt', 'sanding', 'icy street'],
    label: 'Street not plowed',
    portalCaseTypeName: 'Snow Plowing or Salting or Sanding Request',
    portalCaseTypeGuid: '5ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*plowing*',
    seasonal: 'winter',
  },
  // ── Added 2026-09-28 from the citywide public feed (Sep 21–28: these were 4 of the top 14 city types, all absent here) ──
  trash_private: {
    group: 'trash', object: 'trash_ground', facet: { q: 'where2', a: 'private' }, demand: 19, synonyms: ['litter', 'messy yard', 'garbage pile'],
    label: 'Trash on private property or sidewalk',
    portalCaseTypeName: 'Trash on Private Property or Sidewalk',
    portalCaseTypeGuid: '68e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Private Property or Sidewalk*',
  },
  trash_public: {
    group: 'trash', object: 'trash_ground', facet: { q: 'where2', a: 'public' }, demand: 6, synonyms: ['litter', 'overflowing trash can', 'garbage on the street'],
    label: 'Trash on the street or public property',
    portalCaseTypeName: 'Trash on Streets and Public Property',
    portalCaseTypeGuid: '6d0efb0b-0454-ef11-a317-001dd8068673',
    portalSearchTerm: '*Streets and Public*',
  },
  storm_drain: {
    group: 'streets', object: 'drain', facet: { q: 'drainKind', a: 'blocked' }, demand: 7, synonyms: ['catch basin', 'clogged drain', 'sewer grate', 'leaves in drain'],
    label: 'Blocked storm drain',
    portalCaseTypeName: 'Blocked Storm Drain or Catch Basin',
    portalCaseTypeGuid: 'c4e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Storm Drain*',
  },
  traffic_sign: {
    group: 'traffic', object: 'sign_repair', facet: { q: 'signKind', a: 'traffic' }, demand: 11, synonyms: ['stop sign', 'bent sign', 'missing sign', 'street name sign'],
    label: 'Damaged or missing traffic sign',
    portalCaseTypeName: 'Repair a Traffic Sign',
    portalCaseTypeGuid: 'eee7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Repair a Traffic Sign*',
  },
  traffic_control: {
    group: 'traffic', demand: 8, synonyms: ['one way', 'speed bump', 'traffic pattern', 'turn restriction'],
    label: 'Traffic control issue (speeding, signage, striping)',
    portalCaseTypeName: 'Traffic Control Issues or Changes',
    portalCaseTypeGuid: '9ce8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Traffic Control*',
    photoRequired: false,
  },
  overgrowth: {
    group: 'trees', object: 'overgrowth', facet: { q: 'where2', a: 'private' }, demand: 8, synonyms: ['tall grass', 'weeds', 'overgrown lot', 'hedges blocking sidewalk'],
    label: 'Overgrowth or high grass on private property',
    portalCaseTypeName: 'Overgrowth or High Grass on Private Property',
    portalCaseTypeGuid: 'e8e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*High Grass on Private*',
  },
  downed_wire: {
    group: 'lights', demand: 5, synonyms: ['power line', 'telephone pole', 'cable hanging', 'wire hanging low', 'utility pole'],
    label: 'Downed wire or leaning utility (wooden) pole',
    portalCaseTypeName: 'Downed Wire or Leaning Utility Pole',
    portalCaseTypeGuid: 'dae7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Downed Wire*',
    photoRequired: false,
  },
  // ── Added 2026-10-01: full coverage of the reportable types (Rob: "a UI that guides the user to the correct category").
  // Trigger: PVD2026-89374 (a knocked-down city streetlight pole) went out as "Downed Wire or Leaning Utility Pole" and
  // Verizon bounced it — the portal has a dedicated "Report a Leaning City Streetlight Pole" type we didn't map.
  // Step-3 fields for all of these are scouted at submit time until mapped.

  // Trash & recycling
  bins_left_out: {
    group: 'trash', demand: 1, synonyms: ['cans on the curb', 'bins not taken in', 'carts left on sidewalk'],
    label: 'Trash or recycling bins left out',
    portalCaseTypeName: 'Trash or Recycling Bins or Cans Left Out',
    portalCaseTypeGuid: '6ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Cans Left Out*',
  },
  overflowing_dumpster: {
    group: 'trash', demand: 4, synonyms: ['dumpster full', 'dumpster smell', 'commercial dumpster'],
    label: 'Overflowing dumpster',
    portalCaseTypeName: 'Overflowing Dumpster',
    portalCaseTypeGuid: '0e8e7734-cc3f-ef11-8409-001dd800f706',
    portalSearchTerm: '*Overflowing Dumpster*',
  },
  syringes: {
    group: 'trash', demand: 0, synonyms: ['needles', 'sharps', 'drug paraphernalia'],
    label: 'Discarded syringes or needles',
    portalCaseTypeName: 'Discarded Syringes',
    portalCaseTypeGuid: '8ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Syringes*',
  },
  hazardous_waste: {
    group: 'trash', demand: 0, synonyms: ['paint cans', 'chemicals', 'propane tank', 'oil', 'batteries'],
    label: 'Hazardous waste disposal',
    portalCaseTypeName: 'Hazardous Waste Disposal',
    portalCaseTypeGuid: 'f8e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Hazardous Waste*',
    requestType: '1',
    photoRequired: false,
  },
  street_sweeping: {
    group: 'trash', demand: 0, synonyms: ['sweeper', 'street cleaning', 'leaves in the gutter', 'dirty street'],
    label: 'Street sweeping issue',
    portalCaseTypeName: 'Street Sweeping Issue or Concern',
    portalCaseTypeGuid: '5ce8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Street Sweeping*',
    photoRequired: false,
  },
  plastic_bag_ban: {
    group: 'trash', demand: 0, synonyms: ['plastic bags', 'store giving plastic bags', 'bag ban'],
    label: 'Plastic bag ban violation',
    portalCaseTypeName: 'Plastic Bag Ban Violation',
    portalCaseTypeGuid: 'b076f168-cd3f-ef11-8409-001dd800f706',
    portalSearchTerm: '*Plastic Bag*',
    photoRequired: false,
  },
  dpw_general: {
    group: 'streets', demand: 11, hidden: true, synonyms: ['public works', 'DPW'],
    label: 'Other streets / sanitation issue (DPW)',
    portalCaseTypeName: 'General Question or Concern DPW related',
    portalCaseTypeGuid: '63411634-181e-f011-9989-001dd80947ed',
    portalSearchTerm: '*DPW related*',
    photoRequired: false,
  },

  // Streets & sidewalks
  sinkhole: {
    group: 'streets', demand: 3, synonyms: ['road collapsing', 'hole opening up', 'cave in', 'depression in the road'],
    label: 'Sinkhole',
    portalCaseTypeName: 'Sinkhole Concern',
    portalCaseTypeGuid: 'eae7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Sinkhole*',
  },
  street_repair: {
    group: 'streets', demand: 2, synonyms: ['cracked pavement', 'rough road', 'ruts', 'crumbling road', 'repave'],
    label: 'Road surface damaged (not a pothole)',
    portalCaseTypeName: 'Request Street Repair(s)',
    portalCaseTypeGuid: '3ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Street Repair*',
  },
  sidewalk_tree: {
    group: 'streets', object: 'sidewalk', facet: { q: 'sidewalkCause', a: 'tree' }, demand: 5, synonyms: ['roots lifting sidewalk', 'tree roots', 'heaved sidewalk'],
    label: 'Sidewalk lifted by tree roots',
    portalCaseTypeName: 'Sidewalk Issue that is Tree-Related',
    portalCaseTypeGuid: '46e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Tree-Related*',
  },
  sidewalk_request: {
    group: 'streets', demand: 2, synonyms: ['no sidewalk', 'new sidewalk', 'missing sidewalk panel', 'dirt sidewalk'],
    label: 'Missing sidewalk / request a new panel',
    portalCaseTypeName: 'Sidewalk Panel Request',
    portalCaseTypeGuid: '638b20a7-cd3f-ef11-8409-001dd800f706',
    portalSearchTerm: '*Sidewalk Panel Request*',
    requestType: '3',
  },
  crosswalk_striping: {
    group: 'streets', demand: 2, synonyms: ['faded crosswalk', 'road lines', 'lane markings', 'paint worn', 'zebra crossing'],
    label: 'Faded crosswalk or road lines',
    portalCaseTypeName: 'Crosswalk and Road Striping Concerns',
    portalCaseTypeGuid: 'cae7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Striping*',
  },
  manhole_damaged: {
    group: 'streets', object: 'manhole', facet: { q: 'coverKind', a: 'damaged' }, demand: 1, synonyms: ['manhole cover', 'loose cover', 'utility cover', 'rattling cover', 'sunken manhole'],
    label: 'Damaged or loose manhole cover',
    portalCaseTypeName: 'Damaged Manhole or Utility Cover',
    portalCaseTypeGuid: 'cee7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Damaged Manhole*',
  },
  manhole_missing: {
    group: 'streets', object: 'manhole', facet: { q: 'coverKind', a: 'missing' }, demand: 0, synonyms: ['open manhole', 'missing cover', 'uncovered hole'],
    label: 'Missing manhole cover',
    portalCaseTypeName: 'Missing Manhole or Utility Cover',
    portalCaseTypeGuid: '16e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Missing Manhole*',
  },
  storm_drain_damaged: {
    group: 'streets', object: 'drain', facet: { q: 'drainKind', a: 'damaged' }, demand: 0, synonyms: ['broken grate', 'collapsed catch basin', 'missing grate'],
    label: 'Damaged storm drain or catch basin',
    portalCaseTypeName: 'Damaged Storm Drain or Catch Basin',
    portalCaseTypeGuid: 'd2e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Damaged Storm Drain*',
  },
  utility_trench: {
    group: 'streets', demand: 0, synonyms: ['sunken patch', 'trench', 'bad road patch', 'gas company patch', 'water company patch'],
    label: 'Sunken or failed utility trench patch',
    portalCaseTypeName: 'Defective or Failed Utility Trench Repairs',
    portalCaseTypeGuid: 'd6e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Trench*',
  },
  guardrail: {
    group: 'streets', demand: 0, synonyms: ['guard rail', 'barrier', 'railing'],
    label: 'Damaged guardrail',
    portalCaseTypeName: 'Repair Existing Guardrail',
    portalCaseTypeGuid: '2ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Guardrail*',
  },
  bike_path: {
    group: 'streets', demand: 1, synonyms: ['bike lane', 'bike path', 'cycle lane', 'bollard'],
    label: 'Bike lane or bike path problem',
    portalCaseTypeName: 'Bike Path and Lane Issues or Concerns',
    portalCaseTypeGuid: '770b6122-fcee-ef11-be20-001dd8053af7',
    portalSearchTerm: '*Bike Path*',
  },
  pedestrian_bridge: {
    group: 'streets', demand: 0, synonyms: ['pedestrian bridge', 'footbridge', 'river bridge'],
    label: 'Pedestrian bridge issue',
    portalCaseTypeName: 'Concerns or Issues on the Pedestrian Bridge',
    portalCaseTypeGuid: '02e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Pedestrian Bridge*',
    photoRequired: false,
  },

  // Traffic, signs & parking
  overnight_parking: {
    group: 'traffic', demand: 5, synonyms: ['overnight parking', 'parked all night', 'no overnight parking'],
    label: 'Overnight parking violation',
    portalCaseTypeName: 'Overnight Parking Violations',
    portalCaseTypeGuid: '84e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Overnight Parking*',
    photoRequired: false,
  },
  parking_meter: {
    group: 'traffic', demand: 2, synonyms: ['meter broken', 'pay station', 'meter not working', 'kiosk'],
    label: 'Parking meter not working',
    portalCaseTypeName: 'Parking Meters Malfunction',
    portalCaseTypeGuid: '86e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Parking Meters*',
  },
  accessible_parking: {
    group: 'traffic', demand: 0, synonyms: ['handicapped parking', 'disabled parking', 'accessible space blocked'],
    label: 'Accessible (handicapped) parking issue',
    portalCaseTypeName: 'Accessible Parking Issues or Concerns',
    portalCaseTypeGuid: 'bee7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Accessible Parking Issues*',
  },
  scooter: {
    group: 'traffic', demand: 2, synonyms: ['e-scooter', 'scooter blocking sidewalk', 'bird', 'spin', 'veo', 'scooter in the road'],
    label: 'E-scooter blocking the sidewalk or abandoned',
    portalCaseTypeName: 'Electric Scooter Issues',
    portalCaseTypeGuid: 'c2e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Scooter*',
  },
  parking_sign_repair: {
    group: 'traffic', object: 'sign_repair', facet: { q: 'signKind', a: 'parking' }, demand: 1, synonyms: ['parking sign', 'no parking sign', 'permit parking sign'],
    label: 'Damaged or missing parking sign',
    portalCaseTypeName: 'Repair a Parking Sign',
    portalCaseTypeGuid: 'ece7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Repair a Parking Sign*',
  },
  traffic_sign_request: {
    group: 'traffic', object: 'sign_request', facet: { q: 'signKind', a: 'traffic' }, demand: 4, synonyms: ['new stop sign', 'need a sign', 'request sign', 'children at play sign'],
    label: 'Request a new traffic sign',
    portalCaseTypeName: 'Request a New Traffic Sign',
    portalCaseTypeGuid: '98e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*New Traffic Sign*',
    requestType: '3',
    photoRequired: false,
  },
  parking_sign_request: {
    group: 'traffic', object: 'sign_request', facet: { q: 'signKind', a: 'parking' }, demand: 1, synonyms: ['new parking sign', 'no parking sign request'],
    label: 'Request a new parking sign',
    portalCaseTypeName: 'Request a New Parking Sign',
    portalCaseTypeGuid: '34e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*New Parking Sign*',
    requestType: '3',
    photoRequired: false,
  },
  accessible_parking_sign: {
    group: 'traffic', object: 'sign_request', facet: { q: 'signKind', a: 'accessible' }, demand: 2, synonyms: ['handicapped sign', 'accessible parking sign', 'disabled parking space request'],
    label: 'Request an accessible parking sign',
    portalCaseTypeName: 'Accessible and Handicapped Parking Sign Requests',
    portalCaseTypeGuid: '7ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Handicapped Parking Sign*',
    requestType: '3',
    photoRequired: false,
  },
  speeding: {
    group: 'traffic', demand: 2, synonyms: ['speeding cars', 'speed bump request', 'traffic calming', 'drag racing', 'cars going too fast'],
    label: 'Speeding or traffic calming request',
    portalCaseTypeName: 'Speeding and Traffic Calming Concerns',
    portalCaseTypeGuid: 'ef3410cc-cd3f-ef11-8409-001dd800f706',
    portalSearchTerm: '*Traffic Calming*',
    photoRequired: false,
  },
  street_closure: {
    group: 'traffic', demand: 0, synonyms: ['block party', 'close the street', 'road closure permit'],
    label: 'Street closure request',
    portalCaseTypeName: 'Street Closure Request',
    portalCaseTypeGuid: '06e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Street Closure*',
    requestType: '3',
    photoRequired: false,
  },

  // Trees, parks & yards
  overgrowth_public: {
    group: 'trees', object: 'overgrowth', facet: { q: 'where2', a: 'public' }, demand: 2, synonyms: ['tall grass on city lot', 'weeds on the median', 'overgrown park'],
    label: 'Overgrowth or high grass on public property',
    portalCaseTypeName: 'Overgrowth or High Grass Public Property',
    portalCaseTypeGuid: '1ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*High Grass Public*',
  },
  park_maintenance: {
    group: 'trees', demand: 0, synonyms: ['playground', 'park bench', 'ball field', 'park fence', 'park trash', 'dog park'],
    label: 'Problem in a city park',
    portalCaseTypeName: 'Maintenance Issue in a City Park',
    portalCaseTypeGuid: '50e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*City Park*',
  },

  // Lights & wires
  streetlight_pole: {
    group: 'lights', demand: 0, synonyms: ['lamp post', 'light pole', 'pole knocked down', 'pole leaning', 'pole hit by car'],
    label: 'Streetlight pole leaning or knocked down',
    portalCaseTypeName: 'Report a Leaning City Streetlight Pole',
    portalCaseTypeGuid: '3ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Leaning City Streetlight*',
  },
  decorative_light: {
    group: 'lights', demand: 0, synonyms: ['historic light', 'ornamental light', 'acorn light', 'downtown light', 'lantern'],
    label: 'Decorative street light issue',
    portalCaseTypeName: 'Decorative Street Light Issue',
    portalCaseTypeGuid: 'd4e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Decorative Street Light*',
  },

  // Water, sewer & gas
  water_leak: {
    group: 'water', demand: 1, synonyms: ['water main break', 'water bubbling up', 'leak in the street', 'burst pipe'],
    label: 'Water leak or broken water pipe',
    portalCaseTypeName: 'Broken Water Pipe or Water Leaks',
    portalCaseTypeGuid: '4ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Water Leaks*',
  },
  hydrant: {
    group: 'water', demand: 4, synonyms: ['fire hydrant', 'hydrant leaking', 'hydrant open', 'hydrant knocked over'],
    label: 'Fire hydrant issue',
    portalCaseTypeName: 'Fire Hydrant Issue',
    portalCaseTypeGuid: '78e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Hydrant*',
  },
  sewage_backup: {
    group: 'water', demand: 0, synonyms: ['sewer backup', 'sewage in basement', 'sewer overflow', 'sewer smell'],
    label: 'Sewage backup',
    portalCaseTypeName: 'Report Sewage Backup',
    portalCaseTypeGuid: '44e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Sewage Backup*',
    photoRequired: false,
  },
  raw_sewage: {
    group: 'water', demand: 0, synonyms: ['raw sewage', 'sewage leaking', 'plumbing leak', 'waste water'],
    label: 'Raw sewage or faulty plumbing',
    portalCaseTypeName: 'Faulty Plumbing or Raw Sewage',
    portalCaseTypeGuid: 'e4e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Raw Sewage*',
  },
  gas_smell: {
    group: 'water', demand: 0, synonyms: ['gas leak', 'smell gas', 'rotten egg smell', 'natural gas'],
    label: 'Smell of gas',
    portalCaseTypeName: 'Report a Smell of Gas',
    portalCaseTypeGuid: '2ce8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Smell of Gas*',
    photoRequired: false,
  },
  water_quality: {
    group: 'water', demand: 0, synonyms: ['brown water', 'discolored water', 'water smells', 'water pressure', 'cloudy water'],
    label: 'Water quality concern',
    portalCaseTypeName: 'Water Quality Issues or Concerns',
    portalCaseTypeGuid: '110b1e94-b7f3-ef11-be20-001dd804ed86',
    portalSearchTerm: '*Water Quality*',
    photoRequired: false,
  },
  water_meter: {
    group: 'water', demand: 0, synonyms: ['water meter', 'meter reading', 'water bill'],
    label: 'Water meter issue',
    portalCaseTypeName: 'Water Meter Issue',
    portalCaseTypeGuid: '0f0b1e94-b7f3-ef11-be20-001dd804ed86',
    portalSearchTerm: '*Water Meter*',
    photoRequired: false,
  },
  no_utilities: {
    group: 'water', demand: 0, synonyms: ['no water', 'no heat', 'no electricity', 'utilities shut off', 'landlord shut off'],
    label: 'No water, heat or utilities at a property',
    portalCaseTypeName: 'No Public Utilities',
    portalCaseTypeGuid: 'fce7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Public Utilities*',
    photoRequired: false,
  },

  // Animals & pests
  rodents: {
    group: 'animals', demand: 0, synonyms: ['rats', 'mice', 'rodents', 'rat baiting', 'rat burrow'],
    label: 'Rats or rodents',
    portalCaseTypeName: 'Request Rodent Baiting Information',
    portalCaseTypeGuid: '9714e369-5b9a-ef11-8a6a-001dd830140a',
    portalSearchTerm: '*Rodent*',
    requestType: '1',
    photoRequired: false,
  },

  // Buildings & property
  graffiti_private: {
    group: 'property', object: 'graffiti', facet: { q: 'where3', a: 'private' }, demand: 0, synonyms: ['tag', 'spray paint', 'vandalism', 'graffiti on a house', 'graffiti on a store'],
    label: 'Graffiti on private property',
    portalCaseTypeName: 'Graffiti on Private Property',
    portalCaseTypeGuid: '7ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Graffiti on Private*',
  },
  graffiti_park: {
    group: 'property', object: 'graffiti', facet: { q: 'where3', a: 'park' }, demand: 0, synonyms: ['tag', 'spray paint', 'vandalism', 'graffiti in a park', 'graffiti on playground'],
    label: 'Graffiti in a park',
    portalCaseTypeName: 'Graffiti in a Park',
    portalCaseTypeGuid: 'f4e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Graffiti in a Park*',
  },
  vacant_private: {
    group: 'property', object: 'vacant', facet: { q: 'owner', a: 'private' }, demand: 0, synonyms: ['abandoned house', 'vacant lot', 'empty building', 'squatters', 'boarded up'],
    label: 'Abandoned or vacant private property',
    portalCaseTypeName: 'Abandoned or Vacant Private Property Concerns',
    portalCaseTypeGuid: 'c94b243f-dd25-f011-9989-001dd806d5d5',
    portalSearchTerm: '*Vacant Private*',
  },
  vacant_city: {
    group: 'property', object: 'vacant', facet: { q: 'owner', a: 'city' }, demand: 0, synonyms: ['vacant city lot', 'abandoned city building', 'empty school'],
    label: 'Abandoned or vacant city-owned property',
    portalCaseTypeName: 'Abandoned or Vacant City Owned Property Concerns',
    portalCaseTypeGuid: 'bae7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Vacant City*',
  },
  reboarding: {
    group: 'property', demand: 0, synonyms: ['boards removed', 'open vacant house', 'unboarded', 'board up'],
    label: 'Vacant building open or needs re-boarding',
    portalCaseTypeName: 'Request Reboarding of Abandoned Property',
    portalCaseTypeGuid: '3ce8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Reboarding*',
    requestType: '3',
  },
  building_code: {
    group: 'property', demand: 3, synonyms: ['unpermitted work', 'unsafe building', 'code violation', 'collapsing porch', 'illegal construction'],
    label: 'Building code violation',
    portalCaseTypeName: 'Building Code Violations',
    portalCaseTypeGuid: 'c8e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Building Code*',
    photoRequired: false,
  },
  substandard_housing: {
    group: 'property', demand: 7, synonyms: ['no heat', 'mold', 'landlord', 'unsafe apartment', 'bed bugs', 'broken windows', 'leaking roof'],
    label: 'Unsafe or substandard housing conditions',
    portalCaseTypeName: 'Substandard Housing Code Issues or Violations',
    portalCaseTypeGuid: 'c6e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Substandard Housing*',
    photoRequired: false,
  },
  illegal_housing: {
    group: 'property', demand: 0, synonyms: ['illegal apartment', 'basement apartment', 'rooming house', 'too many tenants', 'illegal unit'],
    label: 'Illegal apartment or rooming house',
    portalCaseTypeName: 'Illegal Housing Issues or Concerns',
    portalCaseTypeGuid: '04e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Illegal Housing*',
    photoRequired: false,
  },
  zoning: {
    group: 'property', demand: 1, synonyms: ['zoning', 'business in a house', 'fence too tall', 'short-term rental', 'airbnb', 'land use'],
    label: 'Zoning violation',
    portalCaseTypeName: 'Zoning Violation Concerns',
    portalCaseTypeGuid: '170b1e94-b7f3-ef11-be20-001dd804ed86',
    portalSearchTerm: '*Zoning*',
    photoRequired: false,
  },
  construction_site: {
    group: 'property', object: 'construction', facet: { q: 'constructionIssue', a: 'site' }, demand: 1, synonyms: ['construction dust', 'construction debris', 'unsafe site', 'construction blocking sidewalk', 'construction hours'],
    label: 'Problem at a construction site',
    portalCaseTypeName: 'Concerns with a Construction Site',
    portalCaseTypeGuid: '8ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Construction Site*',
  },
  construction_permit: {
    group: 'property', object: 'construction', facet: { q: 'constructionIssue', a: 'permit' }, demand: 1, synonyms: ['no permit', 'work without a permit', 'permit posted', 'building permit'],
    label: 'Construction without a permit',
    portalCaseTypeName: 'Permit Issues at a Construction Site',
    portalCaseTypeGuid: '22e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Permit Issues*',
    photoRequired: false,
  },
  city_property_maintenance: {
    group: 'property', object: 'city_property', facet: { q: 'cityPropertyKind', a: 'damage' }, demand: 0, synonyms: ['city building', 'broken fence', 'city lot', 'school building', 'fire station', 'library'],
    label: 'Damage or maintenance at a city building or property',
    portalCaseTypeName: 'Maintenance Issue on City Property',
    portalCaseTypeGuid: '12e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Maintenance Issue on City*',
  },
  city_property: {
    group: 'property', object: 'city_property', facet: { q: 'cityPropertyKind', a: 'other' }, demand: 2, synonyms: ['city property', 'city lot', 'city land'],
    label: 'Other concern about city-owned property',
    portalCaseTypeName: 'City-Owned Property Concerns',
    portalCaseTypeGuid: '70e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*City-Owned Property*',
    photoRequired: false,
  },
  accessibility_city: {
    group: 'property', object: 'accessibility', facet: { q: 'where3', a: 'city' }, demand: 0, synonyms: ['wheelchair access', 'curb cut', 'ramp', 'ADA', 'accessible entrance'],
    label: 'Accessibility problem on city property',
    portalCaseTypeName: 'Accessibility Concerns on City Property',
    portalCaseTypeGuid: '0d14e369-5b9a-ef11-8a6a-001dd830140a',
    portalSearchTerm: '*Accessibility Concerns on City*',
  },
  accessibility_private: {
    group: 'property', object: 'accessibility', facet: { q: 'where3', a: 'private' }, demand: 0, synonyms: ['wheelchair access', 'ADA', 'store not accessible', 'no ramp'],
    label: 'Accessibility problem on private property',
    portalCaseTypeName: 'Accessibility Concerns on Private Property',
    portalCaseTypeGuid: '6ae8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Accessibility Concerns on Private*',
  },
  wheelchair_ramp: {
    group: 'property', object: 'accessibility', facet: { q: 'where3', a: 'ramp' }, demand: 0, synonyms: ['wheelchair ramp', 'ramp blocking sidewalk', 'ramp on a house'],
    label: 'Wheelchair ramp on private property',
    portalCaseTypeName: 'Concern about a Wheelchair Ramp on Private Property',
    portalCaseTypeGuid: '6ce8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Wheelchair Ramp*',
  },

  // Noise & neighborhood
  encampment: {
    group: 'nuisance', demand: 1, synonyms: ['tents', 'homeless camp', 'people sleeping', 'camp under the bridge'],
    label: 'Encampment concern',
    portalCaseTypeName: 'Encampment Concern(s)',
    portalCaseTypeGuid: 'f6e7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Encampment*',
    photoRequired: false,
  },
  illegal_vending: {
    group: 'nuisance', demand: 0, synonyms: ['street vendor', 'food cart', 'selling on the sidewalk', 'unlicensed business', 'illegal business'],
    label: 'Illegal business or street vending',
    portalCaseTypeName: 'Illegal Business or Vending Operations',
    portalCaseTypeGuid: '56d37a28-cc3f-ef11-8409-001dd800f706',
    portalSearchTerm: '*Vending*',
    photoRequired: false,
  },
  business_concern: {
    group: 'nuisance', demand: 0, synonyms: ['bar', 'club', 'restaurant', 'store', 'business hours', 'business complaint'],
    label: 'Concern about a business',
    portalCaseTypeName: 'Concerns about a Business',
    portalCaseTypeGuid: 'cce7b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*about a Business*',
    photoRequired: false,
  },
  public_health: {
    group: 'nuisance', demand: 1, synonyms: ['health hazard', 'mosquitoes', 'standing water', 'rotting', 'pests', 'unsanitary'],
    label: 'Public health hazard',
    portalCaseTypeName: 'Report Public Health Hazards',
    portalCaseTypeGuid: '88e8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Public Health*',
    photoRequired: false,
  },
  public_safety: {
    group: 'nuisance', demand: 0, synonyms: ['unsafe', 'danger', 'safety concern', 'hazard'],
    label: 'General public safety concern',
    portalCaseTypeName: 'Report General Public Safety Issues or Concerns',
    portalCaseTypeGuid: '4ee8b671-7a2e-ef11-840a-001dd8039400',
    portalSearchTerm: '*Public Safety*',
    photoRequired: false,
  },
  unsure: {
    group: 'other', demand: 3, synonyms: ['other', 'not sure', 'something else'],
    label: 'Something else',
    portalCaseTypeName: 'I do not know know how to classify my issue or service request.', // renamed by the city after the Aug-21 census (was 'I am unsure or do not know how to classify my request.'); same GUID
    portalCaseTypeGuid: '5c006794-b08c-ef11-ac21-001dd804e2ae',
    portalSearchTerm: '*classify*',
    photoRequired: false,
  },
};

export type Category = keyof typeof CATEGORIES;

export function isCategory(x: unknown): x is Category {
  return typeof x === 'string' && x in CATEGORIES;
}

/** Resolve a FieldSource against a report object. */
export function resolveField(src: FieldSource, report: Record<string, unknown>): string | undefined {
  if ('value' in src) return src.value;
  const v = src.from.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), report);
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number') return String(v);
  return src.default;
}
