// Download every public source the classifier uses into data/raw/ (gitignored).
// One command rebuilds from scratch: `npm run rebuild` (fetch → build-db → citywide).
// No keys needed. Sources and why each matters are in DATA_REPORT.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readCsv } from '../src/csv.ts';
import { COUNT, MAX, pbiGroupedRows } from '../src/powerbi.ts';
import { readXlsx, streamXlsxRows, xlsxRecords } from '../src/xlsx.ts';
import { tableauView } from '../src/tableau.ts';
import { acsTracts } from '../src/acssf.ts';
import { join } from 'node:path';

const RAW = join(import.meta.dirname, '..', 'data', 'raw');
const SOCRATA = 'https://data.providenceri.gov';
const ARCGIS = 'https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services'; // City of Providence GIS
const HUD = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services'; // HUD eGIS open data
const RIGIS = 'https://services2.arcgis.com/S8zZg9pg23JUEexQ/arcgis/rest/services'; // RIGIS (URI) statewide layers

type Source =
  | { name: string; kind: 'socrata'; id: string; select?: string }
  /** `accumulate`: FixMyPVD's case feed only reaches back 90 days, so each fetch is merged into the stored copy by case id. */
  | { name: string; kind: 'json'; url: string; accumulate?: boolean }
  | { name: string; kind: 'leadcerts' }
  /** `lines`: keep the header plus lines matching this regex (national files cut to Rhode Island before they reach disk). */
  | { name: string; kind: 'csv'; url: string; browserUA?: boolean; lines?: string }
  /** A CSV or XLSX released by an agency, reduced at download time to the listed columns (personal contact columns
   *  never reach disk). Written as JSON records. */
  | { name: string; kind: 'records'; url: string; format: 'csv' | 'xlsx'; keep: string[]; headerHint?: string; sheets?: number; browserUA?: boolean;
      /** Stream the sheet row by row and keep only rows whose `column` starts with `startsWith`, or whose `column` value appears in
       *  column `inSource.column` of an earlier source (for national files). */
      stream?: { column: string; startsWith?: string; inSource?: { name: string; column: string } } }
  /** Public Tableau dashboards with downloads turned off: every worksheet of each view, via the page's own session calls. */
  | { name: string; kind: 'tableau'; workbook: string; views: string[] }
  /** ACS 5-year Summary File tract estimates (no API key), cells named → "TABLE_LINE". */
  | { name: string; kind: 'acs_sf'; year: number; cells: Record<string, string> }
  | { name: string; kind: 'arcgis'; service: string; layer?: number; geometry?: boolean; base?: string; where?: string; fields?: string; order?: string;
      /** Douglas-Peucker tolerance in degrees (outSR 4326) — basemap layers only. */ simplify?: number; centroid?: boolean };

export const SOURCES: Source[] = [
  // FY2026 roll (assessment date 12/31/2024, billed Jul 2025). Owner-occupancy levy codes, class, owner + mailing address.
  { name: 'taxroll2026', kind: 'socrata', id: 'p9dd-mw2m', select: '*, :@computed_region_ueqj_g33x, :@computed_region_asue_2ipu' },
  // Prior-year roll, only to measure how often the owner-occupied flag changes year to year (DATA_REPORT.md).
  { name: 'taxroll2025', kind: 'socrata', id: '6ub4-iebe', select: 'tax_map, levy_code_1, class, first_name, last_name, company' },
  // Older rolls: owner-occupied flag history (an owner who held the OO rate in recent years and still owns the place
  // very likely still lives there, even if the certification lapsed).
  { name: 'taxroll2024', kind: 'socrata', id: 'xvti-7dtw', select: 'tax_map, levy_code_1, first_name, last_name, company' },
  { name: 'taxroll2023', kind: 'socrata', id: 'fd8d-n74v', select: 'tax_map, levy_code_1, first_name, last_name, company' },
  { name: 'taxroll2022', kind: 'socrata', id: 'c3q4-f95q', select: 'tax_map, levy_code_1, first_name, last_name, company' },
  { name: 'taxroll2021', kind: 'socrata', id: 'fawc-z8zq', select: 'tax_map, levy_code_1, owner_first_name, owner_last_name, owner_company' },
  { name: 'taxroll2020', kind: 'socrata', id: 'y9h5-fefu', select: 'tax_map, levy_code_1, owner_first_name AS first_name, owner_last_name AS last_name, owner_company AS company' },
  { name: 'taxroll2016', kind: 'socrata', id: 'czje-unnn', select: 'plat_lot_unit, levy_code, owner_first AS first_name, owner_last AS last_name' },
  { name: 'taxroll2019', kind: 'socrata', id: 'twey-459r', select: 'plat_lot_unit, levy_code, owner_first_name AS first_name, owner_last_name AS last_name, owner_company AS company' },
  { name: 'taxroll2018', kind: 'socrata', id: 'yghh-hsch', select: 'plat_lot_unit, levy_code, owner_first_name AS first_name, owner_last_name AS last_name, owner_company AS company' },
  { name: 'taxroll2017', kind: 'socrata', id: 'ku9m-5rhr', select: 'plat_lot_unit, levy_code, owner_first_name AS first_name, owner_last_name AS last_name, owner_company AS company' },
  { name: 'taxroll2015', kind: 'socrata', id: 'r8g6-9zdt', select: 'plat_lot_unit, levy_code, owner_first AS first_name, owner_last AS last_name' },
  { name: 'taxroll2014', kind: 'socrata', id: 't2vi-f8qs', select: 'plat_lot_unit, levy_code, owner_first AS first_name, owner_last AS last_name' },
  { name: 'taxroll2013', kind: 'socrata', id: 'a6uy-vymr', select: 'plat_lot_unit, levy_code, owner_first_name AS first_name' },
  // FY2002–FY2012: no owner-occupied levy split, but the homestead exemption (≥35% of assessed value on an R01 parcel) marks
  // owner-occupants: on FY2012 it agrees with FY2013's levy code on 93% of houses (precision 98%, recall 91%).
  { name: 'taxroll2012', kind: 'socrata', id: 'fgwg-7viq', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2011', kind: 'socrata', id: 'cj3e-g66x', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2010', kind: 'socrata', id: 'p6bs-8exs', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2009', kind: 'socrata', id: '9p3h-3q5i', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2008', kind: 'socrata', id: 'swgn-agtw', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2007', kind: 'socrata', id: 'iafn-rvmp', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2006', kind: 'socrata', id: 'aymi-rpqq', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2005', kind: 'socrata', id: 'yqdi-fbw5', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2004', kind: 'socrata', id: 'fvsz-rky3', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2003', kind: 'socrata', id: 'fek9-hu38', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  { name: 'taxroll2002', kind: 'socrata', id: 'e3qk-fibu', select: 'plat_lot_unit, class, levy_code, total_assessment, total_exemption, owner_first_name AS first_name' },
  // FY2021–23 have no owner-occupied levy code; their exemption amounts are the candidate stand-in.
  { name: 'taxroll2021_values', kind: 'socrata', id: 'fawc-z8zq', select: 'tax_map, levy_code_1, total_assessment AS total_assmt, total_exemption AS total_exempt' },
  { name: 'taxroll2022_values', kind: 'socrata', id: 'c3q4-f95q', select: 'tax_map, levy_code_1, total_assmt, total_exempt' },
  { name: 'taxroll2023_values', kind: 'socrata', id: 'fd8d-n74v', select: 'tax_map, levy_code_1, total_assmt, total_exempt' },
  // Neighborhood polygons the roll's computed region column points into (names + outlines for the map).
  { name: 'neighborhoods', kind: 'socrata', id: 'ueqj-g33x', select: '_feature_id, lname, the_geom' },
  // City GIS parcels joined to the assessor's CAMA extract: unit count, year built, use code.
  { name: 'cama', kind: 'arcgis', service: 'Parcels_with_CAMA' },
  // Lot centers (the roll's points sit on the street, where the address was geocoded): dots are drawn here.
  { name: 'cama_centroids', kind: 'arcgis', service: 'Parcels_with_CAMA', fields: 'PROPID', centroid: true },
  // Providence Housing Authority sites (public housing → regulated affordable).
  { name: 'pha', kind: 'arcgis', service: 'Providence_Housing_Authority', geometry: true, order: 'ObjectId' },
  // Building permits. Socrata "2009-2018" actually holds Dec 2016 – Jan 2020; the ArcGIS map holds Jan 2019 – Mar 2024.
  // No certificate-of-occupancy records in either; new-building / conversion permits stand in for CO dates.
  { name: 'permits_2016_2020', kind: 'socrata', id: 'ufmm-rbej',
    select: 'permitnum, permittype, permitclass, workclass, pin, originaladdress1, description, estprojectcost, issueddate, completeddate, statuscurrent, proposeduse, totalsqft' },
  { name: 'permits_2019_2024', kind: 'arcgis', service: 'Interactive_Permitting_Map_(BETA)', order: 'ObjectId',
    fields: 'Record__,Record_Type,Date_Submitted,Permit_License_Issued_Date,Address,Mbl,Record_Status,Project_Cost,Description_of_Work,Structure_Type,Occupancy_Type' },
  // Basemap layers for the map (the artifact host allows no outside tiles): named streets, parks, water parcels.
  // Base zoning districts (510 polygons). Joined to parcels by lot centroid in derive.ts → parcel_zoning.
  { name: 'zoning', kind: 'arcgis', service: 'PVD_ZoningMap', layer: 15, geometry: true, fields: 'Code,District' },
  // Overlay districts (historic, Downcity, Capital Center, transit-oriented, institutional, I-195): several can cover one lot.
  { name: 'overlay_zoning', kind: 'arcgis', service: 'Overlay_Zoning', geometry: true, fields: 'ZONE,DISTRICT' },
  // The assessor's valid sales used for the 2024 revaluation (calendar 2024). Owner columns are not requested.
  { name: 'sales_2024', kind: 'arcgis', service: 'Parcels_wCAMA_Valid_Sales_2024_Reval', layer: 24, order: 'OBJECTID_1',
    fields: 'PROPID,CLASS,ParcAddress,Sale_Date,Sale_Price,NumUnits,Instrument_Type,N_A_L__Code,Building_Type,Primary_LUC,Total_Assessed_Value,YearBuilt,Quality,Condition,Total_Finished_Area' },
  // Code-enforcement records 2013–2024 (a 999-row snapshot, last edited 2024-03). Owner name is not requested.
  { name: 'code_cases_history', kind: 'arcgis', service: 'Violations_Code_Enforcement_', order: 'FID',
    fields: 'Record__,Address,Mbl,Record_Status,Date_of_First_Inspection,Complaint_Type,Violations_Found_,Condemnation,Building_Type,Date_1NOV_Issued,Date_2NOV_Issued,Date_Condemnation_Issued' },
  // Providence Water lead service lines (private side), 16,588 lines, edited 2025-01. Joined to the lot the line ends in.
  { name: 'lead_service_lines', kind: 'arcgis', service: 'Private_Side_Lead_Providence', layer: 31, geometry: true, fields: 'LOCATIONID,PRIV_SIDE_,GrantEligibility' },
  // Parcels in FEMA's 1% (100-year) and 1%-or-0.2% flood areas, city layers from 2019; plat-lot in MAP_PAR_ID ("08008660000").
  { name: 'flood_parcels_1pct', kind: 'arcgis', service: 'Parcels1percent', fields: 'MAP_PAR_ID' },
  { name: 'flood_parcels_02pct', kind: 'arcgis', service: 'Parcels1andpoint2percent', fields: 'MAP_PAR_ID' },
  // National Register historic districts (2016 layer); local historic zoning is in overlay_zoning.
  { name: 'historic_districts_nr', kind: 'arcgis', service: 'Federal_Historic_Districts_2016', geometry: true, fields: 'SITENAME1' },
  { name: 'basemap_streets', kind: 'arcgis', service: 'Labelled_Streets', geometry: true, fields: 'NAME,SUM_ROADCLASS,MAX_ROADTYPE', simplify: 0.00002 },
  { name: 'basemap_roads', kind: 'arcgis', service: 'City_Maintained_Roads', geometry: true, fields: 'Name,Funcitonal', simplify: 0.00001 },
  // Lot outlines (simplified) — the map shades lots with no homes on record.
  { name: 'parcel_shapes', kind: 'arcgis', service: 'Parcels_with_CAMA', geometry: true, fields: 'PROPID', simplify: 0.000008 },
  // Every street address (state E-911 points): a lot like 280 Waterman St also holds 209–221 Medway St.
  { name: 'address_points', kind: 'arcgis', base: RIGIS, service: 'FACILITY_AddressPoints_E911domains', layer: 5, geometry: true,
    where: "municipality='PROVIDENCE' AND addrnum IS NOT NULL", fields: 'addrnum,addrnumsuf,fullname,pointtype' },
  // Building footprints (city GIS), colored by their lot's result at street zoom.
  { name: 'building_shapes', kind: 'arcgis', service: 'Buildings_layer', geometry: true, fields: 'OBJECTID', simplify: 0.000005 },
  { name: 'basemap_parks', kind: 'arcgis', service: 'Parks_And_Open_Space', geometry: true, fields: 'PARKNAME,ACRES', simplify: 0.00002 },
  { name: 'basemap_water', kind: 'arcgis', service: 'Parcels_with_CAMA', geometry: true, where: "POLY_TYPE='WATER'", fields: 'OBJECTID', simplify: 0.00002 },
  // Census tracts (ACS 2020–2024 5-year via Census Reporter, no key): income overall and for renters, race/ethnicity,
  // tenure, median gross rent, rent burden — plus tract outlines. For who-is-covered comparisons by area.
  { name: 'acs_tracts', kind: 'json', url: 'https://api.censusreporter.org/1.0/data/show/latest?table_ids=B19013,B25119,B03002,B25003,B25064,B25071&geo_ids=140|16000US4459000' },
  // Earlier ACS 5-year releases (2010-tract geography) from the Summary File, for change over a decade. Same measures as acs_tracts.
  ...[2014, 2019].map((year) => ({ name: `acs_tracts_${year}`, kind: 'acs_sf' as const, year, cells: {
    households: 'B25003_001', renter_households: 'B25003_003', median_income: 'B19013_001', renter_median_income: 'B25119_003',
    pop: 'B03002_001', white_nh: 'B03002_003', black_nh: 'B03002_004', hispanic: 'B03002_012', asian_nh: 'B03002_006',
    median_gross_rent: 'B25064_001', rent_burden_median_pct: 'B25071_001' } })),
  { name: 'acs_tract_shapes', kind: 'json', url: 'https://api.censusreporter.org/1.0/geo/show/tiger2023?geo_ids=140|16000US4459000' },
  // Eviction filings by tract and month, Jan 2020 → now (Eviction Lab ETS; data from RIHousing / the courts).
  // Their CDN refuses non-browser user agents for this public CSV.
  { name: 'evictions_tracts', kind: 'csv', url: 'https://evictionlab.org/uploads/providence_monthly_2020_2021.csv', browserUA: true },
  // Zillow Observed Rent Index (asking rents), monthly: city and ZIP files (we keep the Providence rows).
  { name: 'zori_city', kind: 'csv', url: 'https://files.zillowstatic.com/research/public_csvs/zori/City_zori_uc_sfrcondomfr_sm_month.csv' },
  { name: 'zori_zip', kind: 'csv', url: 'https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv' },
  // Zillow home value index (typical home, middle third), city and ZIP, Rhode Island rows only.
  // FHFA house price index by census tract (annual, repeat sales, developmental series), Providence County rows only.
  { name: 'fhfa_hpi_tract', kind: 'csv', lines: '^44007', browserUA: true, url: 'https://www.fhfa.gov/hpi/download/annually/hpi_at_tract.csv' },
  { name: 'zhvi_city', kind: 'csv', lines: ',RI,', url: 'https://files.zillowstatic.com/research/public_csvs/zhvi/City_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv' },
  { name: 'zhvi_zip', kind: 'csv', lines: ',RI,', url: 'https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv' },
  // All building permits Dec 2016 → 2026-09-15: the city's OpenGov export, released publicly in response to records
  // request 26-2355 (providenceri.nextrequest.com). Has "Type of Improvement" and "Number of Dwelling Units"; no parcel id.
  { name: 'permits_2016_2026', kind: 'csv', url: 'https://providenceri.nextrequest.com/documents/70401717/download' },
  // Released datasets from the public-records portals and state rosters (see DATA_SOURCES.md). Only non-personal
  // columns are kept: no owner/manager/applicant/host names, emails or phone numbers.
  { name: 'ridoh_rental_registry', kind: 'records', format: 'xlsx', headerHint: 'Street Address',
    url: 'https://healthandhumanservicesdepts-ri.nextrequest.com/documents/62808486/download', // RIDOH APRA 26-278, ~2026-05
    keep: ['Street Address', 'Number of Units', 'License Advisory', 'Built Before 1978', 'Is Exempt'] },
  { name: 'housing_court_cases', kind: 'records', format: 'xlsx', headerHint: 'CASE NO.',
    url: 'https://providenceri.nextrequest.com/documents/60717056/download', // city APRA 26-521, 1998 → 2026-03
    keep: ['CASE NO.', 'Prop.#', 'Property St', 'PLAT', 'LOT', 'DATE FILED', 'PRF', 'RCVR', 'CLOSED', 'FINAL JUDGMENT', 'AMOUNT'] },
  { name: 'vacant_registry', kind: 'records', format: 'xlsx', headerHint: 'ADDRESS', sheets: 5,
    url: 'https://providenceri.nextrequest.com/documents/43471545/download', // city APRA 25-339: one sheet per registration year (~2017–2025)
    keep: ['ADDRESS', 'PLAT', 'LOT'] },
  { name: 'code_cases_active', kind: 'records', format: 'xlsx', headerHint: 'Record #',
    url: 'https://providenceri.nextrequest.com/documents/64624609/download', // city APRA 26-1279 pt 1: active code cases 2023 → 2026-06
    keep: ['Record #', 'Occupancy Type', 'Mbl', 'Address', 'Date Submitted', 'Last Record Activity', 'Record Status'] },
  // HUD Small Area Fair Market Rents FY2027 (whole US; Providence ZIPs kept at build time). huduser.gov wants a browser UA.
  { name: 'hud_safmr_fy27', kind: 'records', format: 'xlsx', headerHint: 'HUD Area Code', browserUA: true,
    url: 'https://www.huduser.gov/portal/datasets/fmr/fmr2027/FY27_safmrs.xlsx',
    keep: ['ZIP Code', 'HUD Area Code', 'SAFMR 0BR', 'SAFMR 1BR', 'SAFMR 2BR', 'SAFMR 3BR', 'SAFMR 4BR'] },
  { name: 'str_city_permits', kind: 'records', format: 'csv',
    url: 'https://providenceri.nextrequest.com/documents/69800665/download', // city APRA 26-2245, 2024-09 → 2026-09
    keep: ['Record #', 'Record Type', 'Date Submitted', 'Address', 'Record Status'] },
  { name: 'str_state_roster', kind: 'records', format: 'csv',
    url: 'https://ridbrprod.state-reg-eastern.tylerapp.com/licensing/page.request.do?page=page.shorttermRentalRoster', // DBR, daily, active only
    keep: ['License No.', 'License Status', 'Effective Date', 'Expiration Date', 'STR Address 1', 'STR Address 2', 'STR City', 'STR Zip Code'] },
  { name: 'airbnb_listings', kind: 'records', format: 'csv',
    url: 'https://data.insideairbnb.com/united-states/ri/rhode-island/2026-09-28/visualisations/listings.csv', // Inside Airbnb, CC BY 4.0
    keep: ['id', 'neighbourhood', 'room_type', 'price', 'minimum_nights', 'number_of_reviews_ltm', 'availability_365', 'license', 'latitude', 'longitude'] },
  // RIDOH lead certificates (public Power BI report, refreshed daily): one row per Providence address with certificate
  // count, latest letter date and units, from the current and legacy (HRC-era) certificate tables.
  { name: 'lead_certificates', kind: 'leadcerts' },
  // HUD Housing Choice Voucher households per tract (current HUD extract).
  // HUD Picture of Subsidized Households 2025 (as of 2025-12-31, 2020 tracts): per tract × program (all programs, vouchers,
  // public housing, project-based Section 8, 202/811, mod rehab) — units, occupancy, rent paid, household income, AMI bands,
  // household makeup. One 500 MB sheet for 30 states, so it is streamed and cut to Providence County. -1/-4 = suppressed.
  { name: 'hud_psh_tract_2025', kind: 'records', format: 'xlsx', browserUA: true, headerHint: 'program_label',
    url: 'https://www.huduser.gov/portal/datasets/pictures/files/TRACT_MO_WY_2025_2020census.xlsx', stream: { column: 'code', startsWith: '44007' },
    keep: ['code', 'program_label', 'sub_program', 'total_units', 'total_occupied', 'pct_occupied', 'people_total', 'rent_per_month', 'spending_per_month',
      'hh_income', 'pct_lt80_median', 'pct_lt50_median', 'pct_lt30_median', 'pct_age62plus', 'pct_disabled_all', 'pct_female_head_child',
      'pct_minority', 'pct_black_nonhsp', 'pct_hispanic', 'pct_white_nothsp', 'months_waiting', 'months_from_movein', 'pct_overhoused', 'Quarter'] },
  // HUD Multifamily Assistance & Section 8 Contracts database (refreshed monthly): every HUD-assisted multifamily property and
  // its rental-assistance contracts, with each contract's expiration date. The property file also lists owner and agent
  // people with phones and emails; only property-level columns are kept.
  { name: 'hud_mf_properties', kind: 'records', format: 'xlsx', browserUA: true, headerHint: 'property_id', stream: { column: 'state_code', startsWith: 'RI' },
    url: 'https://www.hud.gov/sites/dfiles/Housing/documents/MF-Properties-with-Assistance-Sec8-Contracts1.xlsx',
    keep: ['property_id', 'property_name_text', 'address_line1_text', 'city_name_text', 'state_code', 'zip_code', 'property_total_unit_count',
      'property_category_name', 'primary_financing_type', 'is_202_811_ind', 'is_assisted_living_ind', 'is_nursing_home_ind', 'is_hud_owned_ind'] },
  { name: 'hud_mf_contracts', kind: 'records', format: 'xlsx', browserUA: true, headerHint: 'contract_number',
    stream: { column: 'property_id', inSource: { name: 'hud_mf_properties', column: 'property_id' } },
    url: 'https://www.hud.gov/sites/dfiles/Housing/documents/MF-Assistance-Sec8-Contracts1.xlsx',
    keep: ['contract_number', 'property_id', 'tracs_effective_date', 'tracs_overall_expiration_date', 'tracs_current_expiration_date', 'tracs_status_name',
      'contract_term_months_qty', 'assisted_units_count', 'program_type_name', 'program_type_group_name', 'rent_to_FMR_ratio', 'rent_to_FMR_description'] },
  // City 311 cases from FixMyPVD's public map feed (the city's own public grid shows only 7 days; FixMyPVD has kept every case
  // since 2026-10-09). Case type, status, dates and the street address the city shows — no reporter, no description.
  // The feed's longest window is 90 days, so each rebuild sees the last 90 days only (see DATA_SOURCES.md).
  { name: 'city_cases_fixmypvd', kind: 'json', url: 'https://api.fixmypvd.org/api/street/map?days=90', accumulate: true },
  // RIHousing dashboards (Tableau Public, downloads off): the annual rent survey (CoStar-based, large buildings) and the
  // evictions tracker (court data: filings, hearings, judgments, money awards; cases per renter by ZIP).
  { name: 'rihousing_rent_survey', kind: 'tableau', workbook: 'RentSurveyDashboard', views: ['RentSurveyDashboard'] },
  { name: 'rihousing_evictions', kind: 'tableau', workbook: 'EvictionsTrackingDashboard', views: ['EvictionsDashboardpage1', 'EvictionsDashboardpage2'] },
  // Assessor (Vision) extracts released for city APRA 20-209: every parcel's last six sales (date, price, sale code, qualified,
  // improved). 2013 and 2019 together reach back to the 1990s. Owner, grantee and mailing columns are not kept.
  { name: 'sales_history_2019', kind: 'records', format: 'xlsx', browserUA: true, headerHint: 'VISION ID', stream: { column: 'Map' },
    url: 'https://providenceri.nextrequest.com/documents/4804481/download', keep: ['Map', 'Lot', 'Unit', 'STREET NUM', 'STREET NAME', 'SALE DATE 1', 'SALE PRICE 1', 'SALE CODE 1', 'QUALIFIED 1', 'IMPROVED 1', 'SALE DATE 2', 'SALE PRICE 2', 'SALE CODE 2', 'QUALIFIED 2', 'IMPROVED 2', 'SALE DATE 3', 'SALE PRICE 3', 'SALE CODE 3', 'QUALIFIED 3', 'IMPROVED 3', 'SALE DATE 4', 'SALE PRICE 4', 'SALE CODE 4', 'QUALIFIED 4', 'IMPROVED 4', 'SALE DATE 5', 'SALE PRICE 5', 'SALE CODE 5', 'QUALIFIED 5', 'IMPROVED 5', 'SALE DATE 6', 'SALE PRICE 6', 'SALE CODE 6', 'QUALIFIED 6', 'IMPROVED 6', 'STYLE', 'ACTUAL YEAR BUILT'] },
  { name: 'sales_history_2013', kind: 'records', format: 'xlsx', browserUA: true, headerHint: 'VISION ID', stream: { column: 'Map' },
    url: 'https://providenceri.nextrequest.com/documents/4804482/download', keep: ['Map', 'Lot', 'Unit', 'STREET NUM', 'STREET NAME', 'SALE DATE 1', 'SALE PRICE 1', 'SALE CODE 1', 'QUALIFIED 1', 'IMPROVED 1', 'SALE DATE 2', 'SALE PRICE 2', 'SALE CODE 2', 'QUALIFIED 2', 'IMPROVED 2', 'SALE DATE 3', 'SALE PRICE 3', 'SALE CODE 3', 'QUALIFIED 3', 'IMPROVED 3', 'SALE DATE 4', 'SALE PRICE 4', 'SALE CODE 4', 'QUALIFIED 4', 'IMPROVED 4', 'SALE DATE 5', 'SALE PRICE 5', 'SALE CODE 5', 'QUALIFIED 5', 'IMPROVED 5', 'SALE DATE 6', 'SALE PRICE 6', 'SALE CODE 6', 'QUALIFIED 6', 'IMPROVED 6', 'STYLE', 'ACTUAL YEAR BUILT'] },
  // Code cases with lead-hazard violations (LHMA 42-128.1-8), active and released, APRA 22-1323 (2022). Owner not kept.
  { name: 'lead_violations_2022', kind: 'records', format: 'xlsx', browserUA: true, sheets: 1, url: 'https://providenceri.nextrequest.com/documents/16739719/download',
    keep: ['Status', 'Number', 'Address', 'Complaint Date', 'Complaint Reason', 'Inspection Date', '1st NOV Issue Date', '# Violations (1st)', 'Lead Added', '2nd NOV Issue Date'] },
  { name: 'lead_violations_2022_released', kind: 'records', format: 'xlsx', browserUA: true, url: 'https://providenceri.nextrequest.com/documents/16739720/download',
    keep: ['Status', 'Number', 'Address', 'Complaint Date', 'Complaint Reason', 'Inspection Date', '1st NOV Issue Date', '# Violations (1st)', 'Lead Added', '2nd NOV Issue Date', '1st NOV Release Date'] },
  // RIDOH's list of properties it suspects are rented but not registered (as of 2025-05-01), public release of RIDOH APRA
  // 26-225; it drove the winter 2025 enforcement letters. Owner names and addresses are never downloaded.
  { name: 'ridoh_suspected_rentals', kind: 'records', format: 'xlsx', browserUA: true,
    url: 'https://healthandhumanservicesdepts-ri.nextrequest.com/documents/61611122/download', keep: ['parcel_id', 'alt_parcel_id', 'street_address', 'city', 'zip_code'] },
  // HMDA public loan records (CFPB, anonymized: no names or addresses), originated loans in Providence County, 2018–2024:
  // tract, purpose, occupancy (1 owner-occupant, 2 second home, 3 investor), units, loan amount, property value, income.
  { name: 'hmda_2018', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2018&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hmda_2019', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2019&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hmda_2020', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2020&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hmda_2021', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2021&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hmda_2022', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2022&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hmda_2023', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2023&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hmda_2024', kind: 'records', format: 'csv', url: 'https://ffiec.cfpb.gov/v2/data-browser-api/view/csv?counties=44007&years=2024&actions_taken=1',
    keep: ['activity_year', 'census_tract', 'loan_purpose', 'occupancy_type', 'total_units', 'loan_amount', 'property_value', 'income', 'derived_dwelling_category', 'business_or_commercial_purpose'] },
  { name: 'hud_vouchers_tract', kind: 'arcgis', base: HUD, service: 'Housing_Choice_Vouchers_by_Tract', where: "GEOID LIKE '44007%'", fields: 'GEOID,HCV_PUBLIC,HCV_PUBLIC_PCT' },
  // HUD: LIHTC projects, project-based assisted multifamily, public housing buildings (regulated affordable).
  { name: 'hud_lihtc', kind: 'arcgis', base: HUD, service: 'LIHTC', where: "PROJ_CTY='PROVIDENCE' AND PROJ_ST='RI'",
    fields: 'HUD_ID,PROJECT,PROJ_ADD,STD_ADDR,N_UNITS,LI_UNITS,YR_PIS,LAT,LON' },
  { name: 'hud_multifamily', kind: 'arcgis', base: HUD, service: 'MULTIFAMILY_PROPERTIES_ASSISTED', where: "PLACED_BASE_CITY_NAME_TEXT='Providence' AND STD_ST='RI'",
    fields: 'PROPERTY_ID,PROPERTY_NAME_TEXT,ADDRESS_LINE1_TEXT,STD_ADDR,TOTAL_UNIT_COUNT,TOTAL_ASSISTED_UNIT_COUNT,PROPERTY_CATEGORY_NAME,EXPIRATION_DATE1,LAT,LON' },
  { name: 'hud_public_housing', kind: 'arcgis', base: HUD, service: 'Public_Housing_Buildings', where: "PARTICIPANT_CODE='RI001'",
    fields: 'NATIONAL_BLDG_ID,PROJECT_NAME,BUILDING_NAME,STD_ADDR,TOTAL_UNITS,BUILDING_TYPE_CODE,LAT,LON' },
];

async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'pvd-rentstab/0.1 (Providence rent-stabilization data spike; fixmypvd.org)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function fetchSocrata(s: Extract<Source, { kind: 'socrata' }>): Promise<any[]> {
  const rows: any[] = [];
  const page = 50000;
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({ $limit: String(page), $offset: String(offset), $order: ':id' });
    if (s.select) q.set('$select', s.select);
    const batch = await getJson(`${SOCRATA}/resource/${s.id}.json?${q}`);
    rows.push(...batch);
    if (batch.length < page) return rows;
  }
}

async function fetchArcgis(s: Extract<Source, { kind: 'arcgis' }>): Promise<any[]> {
  const base = `${s.base ?? ARCGIS}/${s.service}/FeatureServer/${s.layer ?? 0}/query`;
  const rows: any[] = [];
  const page = 2000;
  // Advance by what came back: some layers cap pages below 2000 (maxRecordCount 1000) and flag exceededTransferLimit.
  for (let offset = 0; ; ) {
    const q = new URLSearchParams({
      where: s.where ?? '1=1', outFields: s.fields ?? '*', returnGeometry: String(!!s.geometry), outSR: '4326',
      orderByFields: s.order ?? 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(page), f: 'json',
    });
    if (s.simplify) { q.set('maxAllowableOffset', String(s.simplify)); q.set('geometryPrecision', '6'); }
    if (s.centroid) q.set('returnCentroid', 'true');
    const body = await getJson(`${base}?${q}`);
    if (body.error) throw new Error(`${s.service}: ${JSON.stringify(body.error)}`);
    rows.push(...body.features.map((f: any) => ({ ...f.attributes, ...(s.geometry ? { _geometry: f.geometry } : {}), ...(s.centroid ? { _centroid: f.centroid } : {}) })));
    offset += body.features.length;
    if (!body.features.length || (!body.exceededTransferLimit && body.features.length < page)) return rows;
  }
}

/** FixMyPVD map feed → resolved cases (type and status names instead of per-response indices), merged with the stored copy
 *  by case id; the newer fetch wins for a case seen in both. */
function accumulateCases(feed: any, path: string): { v: 'accumulated'; at: string; firstDay: string | null; items: Record<string, unknown>[] } {
  const resolve = (f: any) => (f?.v === 'accumulated' ? f.items : (f?.items ?? []).map((i: any[]) => ({
    guid: i[0], caseType: f.types[i[1]]?.[0] ?? null, category: f.types[i[1]]?.[1] ?? null, status: f.statuses[i[2]] ?? null,
    createdMin: i[3], closedMin: i[4], lat: i[5], lng: i[6], street: i[7], resolution: i[8] || null,
  })));
  const old = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of [...resolve(old), ...resolve(feed)]) byId.set(String(c.guid), c);
  const firstDay = [old?.firstDay, feed?.firstDay].filter(Boolean).sort()[0] ?? null;
  return { v: 'accumulated', at: new Date().toISOString(), firstDay, items: [...byId.values()] };
}

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
async function getText(url: string, browserUA = false): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': browserUA ? BROWSER_UA : 'pvd-rentstab/0.1 (Providence rent-stabilization data spike; fixmypvd.org)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  // ONLY=name,name refetches a subset and keeps the rest of the manifest.
  const only = process.env.ONLY?.split(',').map((x) => x.trim());
  const manifestPath = join(RAW, 'manifest.json');
  const manifest: Record<string, { rows: number; fetchedAt: string; url: string }> =
    only && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const s of SOURCES) {
    if (only && !only.includes(s.name)) continue;
    if (s.kind === 'leadcerts') {
      const rpt = { url: 'https://wabi-us-gov-virginia-api.analysis.usgovcloudapi.net/public/reports/querydata?synchronous=true',
        resourceKey: '01bdc794-2864-41cd-9f47-dadb84abde12', datasetId: '08d6da19-9904-4cf9-8466-48be8303548b', reportId: '80eec9e1-a841-4def-943d-a18efcb692af', modelId: 550161 };
      const groups = ['AddressID', 'StrNum', 'StrName', 'StrType', 'Zip', 'YearBuilt'];
      const rows = [
        ...(await pbiGroupedRows(rpt, 'New Certificates', groups, [['CaseID', COUNT, 'certs'], ['LetterDate', MAX, 'last'], ['NuMUnits', MAX, 'units']], ['Town', 'Providence'])).map((r) => ({ ...r, era: 'current' })),
        ...(await pbiGroupedRows(rpt, 'Old Certificates', groups, [['CaseID', COUNT, 'certs'], ['LetterDate', MAX, 'last'], ['NumUnits', MAX, 'units']], ['Town', 'Providence'])).map((r) => ({ ...r, era: 'legacy' })),
      ];
      writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(rows));
      manifest[s.name] = { rows: rows.length, fetchedAt: new Date().toISOString(), url: 'RIDOH lead certificate Power BI report (public)' };
      console.log(`${s.name}: ${rows.length} address rows`);
      continue;
    }
    if (s.kind === 'acs_sf') {
      const rows = await acsTracts({ year: s.year, st: 'ri', stateDir: 'RhodeIsland', prefix: '14000US44007', cells: s.cells });
      writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(rows));
      manifest[s.name] = { rows: rows.length, fetchedAt: new Date().toISOString(), url: `https://www2.census.gov/programs-surveys/acs/summary_file/${s.year}/` };
      console.log(`${s.name}: ${rows.length} tracts`);
      continue;
    }
    if (s.kind === 'tableau') {
      const out: Record<string, unknown> = {};
      for (const v of s.views) out[v] = await tableauView(s.workbook, v);
      writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(out));
      const sheets = Object.values(out).flatMap((v) => Object.keys(v as object));
      manifest[s.name] = { rows: sheets.length, fetchedAt: new Date().toISOString(), url: `https://public.tableau.com/views/${s.workbook}` };
      console.log(`${s.name}: ${sheets.length} worksheets`);
      continue;
    }
    if (s.kind === 'records') {
      let recs: Record<string, string>[];
      if (s.format === 'xlsx') {
        const res = await fetch(s.url, { headers: { 'user-agent': s.browserUA ? BROWSER_UA : 'pvd-rentstab/0.1 (Providence rent-stabilization data spike; fixmypvd.org)' } });
        if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        recs = [];
        if (s.stream) {
          const { column, startsWith, inSource } = s.stream;
          const allowed = inSource ? new Set(JSON.parse(readFileSync(join(RAW, `${inSource.name}.json`), 'utf8')).map((r: any) => String(r[inSource.column]).trim())) : null;
          const keepRow = (v: string) => (startsWith == null || v.startsWith(startsWith)) && (!allowed || allowed.has(v.trim())); // no filter → every row
          let head: string[] | null = null, at = -1;
          streamXlsxRows(buf, (r) => {
            if (!head) { if (r.some((c) => c.trim() === (s.headerHint ?? s.keep[0]))) { head = r.map((c) => c.trim()); at = head.indexOf(column); } return; }
            if (keepRow(r[at] ?? '')) recs.push(Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
          });
        } else for (let sheet = 1; sheet <= (s.sheets ?? 1); sheet++) {
          recs.push(...xlsxRecords(readXlsx(buf, sheet), s.headerHint ?? s.keep[0]).map((r) => ({ ...r, sheet: String(sheet) })));
        }
      } else {
        recs = readCsv((await getText(s.url, s.browserUA)).replace(/^\uFEFF/, ''));
      }
      // Headers carry stray spaces and line breaks ("PLAT ", "ZIP\nCode"): match on whitespace-collapsed names.
      const kept = recs.map((r) => {
        const byTrim = new Map(Object.entries(r).map(([k, v]) => [k.replace(/\s+/g, ' ').trim(), v]));
        return Object.fromEntries(s.keep.map((k) => [k, byTrim.get(k) ?? '']));
      });
      writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(kept));
      manifest[s.name] = { rows: kept.length, fetchedAt: new Date().toISOString(), url: s.url };
      console.log(`${s.name}: ${kept.length} rows (kept ${s.keep.length} columns)`);
      continue;
    }
    if (s.kind === 'csv') {
      const text = await getText(s.url, s.browserUA);
      if (!/^[^<]/.test(text) || !text.includes(',')) throw new Error(`${s.name}: expected CSV, got ${text.slice(0, 80)}`);
      const kept = s.lines ? (() => { const all = text.split('\n'), re = new RegExp(s.lines); return [all[0], ...all.slice(1).filter((l) => re.test(l))].join('\n'); })() : text;
      writeFileSync(join(RAW, `${s.name}.csv`), kept);
      manifest[s.name] = { rows: kept.split('\n').length - 1, fetchedAt: new Date().toISOString(), url: s.url };
      console.log(`${s.name}: ${manifest[s.name].rows} rows`);
      continue;
    }
    let rows = s.kind === 'socrata' ? await fetchSocrata(s) : s.kind === 'json' ? await getJson(s.url) : await fetchArcgis(s);
    if (s.kind === 'json' && s.accumulate) rows = accumulateCases(rows, join(RAW, `${s.name}.json`));
    writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(rows));
    manifest[s.name] = {
      rows: Array.isArray(rows) ? rows.length : (rows.items?.length ?? Object.keys(rows.data ?? rows.features ?? {}).length),
      fetchedAt: new Date().toISOString(),
      url: s.kind === 'socrata' ? `${SOCRATA}/d/${s.id}` : s.kind === 'json' ? s.url : `${s.base ?? ARCGIS}/${s.service}/FeatureServer/${s.layer ?? 0}`,
    };
    console.log(`${s.name}: ${manifest[s.name].rows} rows`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

if (import.meta.main) await main();
