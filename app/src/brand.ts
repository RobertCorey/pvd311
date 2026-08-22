// Every brand string lives here (docs/product-spec.md §1–2 is the source of truth).
export const BRAND = {
  name: 'SnapPVD',
  shortName: 'SnapPVD',
  tagline: "Report a Providence street problem in one photo — we file it with the city's 311 for you.",
  heroSub: "Snap a city problem. We'll file it with 311 for you.",
  domain: 'snappvd.org',
  siteUrl: 'https://snappvd.org',
  contactEmail: 'hello@snappvd.org',  // TODO: until the domain + inbox exist, pvdsnow@proton.me still works
  disclaimer: 'SnapPVD is an independent community project and is not affiliated with, endorsed by, or operated by the City of Providence.',
  notTheCity: 'Not the city',
  portalUrl: 'https://311.providenceri.gov',
  themeColor: '#0F766E',
} as const;

export const APP_VERSION = 'app-0.2.0';
