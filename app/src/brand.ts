// Every brand string lives here (docs/product-spec.md §1 + docs/design-direction.md are the source of truth).
export const BRAND = {
  name: 'FixMyPVD',
  shortName: 'FixMyPVD',
  /** Wordmark split: "FixMy" in ink, "PVD" in ember. */
  wordmark: ['FixMy', 'PVD'] as const,
  tagline: "Report a Providence street problem in one photo — we file it with the city's 311 for you.",
  heroSub: "Spot a city problem. We'll file it with 311 for you.",
  domain: 'fixmypvd.org',
  /** Canonical site URL once the domain exists; until then links use the current origin. */
  siteUrl: typeof location !== 'undefined' && /fixmypvd\.org$/.test(location.hostname) ? 'https://fixmypvd.org' : (typeof location !== 'undefined' ? location.origin : 'https://fixmypvd.org'),
  contactEmail: 'rob@fixmypvd.org',  // routed via Cloudflare Email Routing (alice); switch to hello@ once that alias routes
  disclaimer: 'FixMyPVD is an independent community project and is not affiliated with, endorsed by, or operated by the City of Providence.',
  portalUrl: 'https://311.providenceri.gov',
  themeColor: '#F7F1E6',
} as const;

export const APP_VERSION = 'app-0.3.0';
