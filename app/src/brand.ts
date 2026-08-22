// Every brand string lives here. The product-design IC's spec (docs/product-spec.md)
// replaces these values; nothing else in the app should hardcode the name.
export const BRAND = {
  name: 'PVD 311',              // WORKING TITLE
  tagline: 'Report potholes, street lights, missed trash & more to Providence 311 — takes 30 seconds',
  domain: 'pvdsnow.org',        // until the real domain is bought
  contactEmail: 'pvdsnow@proton.me',
  disclaimer: 'Community project — not affiliated with the City of Providence',
  portalUrl: 'https://311.providenceri.gov',
} as const;

export const APP_VERSION = 'app-0.1.0';
