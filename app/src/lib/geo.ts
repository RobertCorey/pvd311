export const PVD_BOUNDS = { minLat: 41.772, maxLat: 41.871, minLng: -71.473, maxLng: -71.37 } as const;
export const inProvidence = (lat: number, lng: number) =>
  lat >= PVD_BOUNDS.minLat && lat <= PVD_BOUNDS.maxLat && lng >= PVD_BOUNDS.minLng && lng <= PVD_BOUNDS.maxLng;

const GEOCODER = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';

export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  const r = await fetch(`${GEOCODER}/reverseGeocode?location=${lng},${lat}&featureTypes=StreetAddress,StreetName,StreetInt&f=pjson`, { signal });
  const d = await r.json();
  const a = d?.address;
  return a ? (a.Address || a.ShortLabel || a.Match_addr || null) : null;
}

export interface GeocodeHit { lat: number; lng: number; label: string; score: number; }
export async function forwardGeocode(text: string, signal?: AbortSignal): Promise<GeocodeHit | null> {
  const q = /providence|,\s*ri\b/i.test(text) ? text : `${text}, Providence, RI`;
  const ext = `${PVD_BOUNDS.minLng - 0.05},${PVD_BOUNDS.minLat - 0.05},${PVD_BOUNDS.maxLng + 0.05},${PVD_BOUNDS.maxLat + 0.05}`;
  const r = await fetch(`${GEOCODER}/findAddressCandidates?SingleLine=${encodeURIComponent(q)}&maxLocations=1&outFields=Match_addr,Addr_type,Score&searchExtent=${ext}&countryCode=USA&f=pjson`, { signal });
  const d = await r.json();
  const c = d?.candidates?.[0];
  if (!c?.location || (c.score ?? 0) < 80) return null;
  return { lat: c.location.y, lng: c.location.x, label: c.attributes?.Match_addr ?? c.address ?? text, score: c.score };
}

/** Read GPS from JPEG EXIF (browser-side, no deps). Returns null when absent. */
export async function readExifGps(file: Blob): Promise<{ lat: number; lng: number } | null> {
  const buf = await file.slice(0, 256 * 1024).arrayBuffer();
  const v = new DataView(buf);
  if (v.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off < v.byteLength - 4) {
    const marker = v.getUint16(off); const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
      const tiff = off + 10;
      const le = v.getUint16(tiff) === 0x4949;
      const u16 = (p: number) => v.getUint16(p, le), u32 = (p: number) => v.getUint32(p, le);
      const ifd0 = tiff + u32(tiff + 4);
      let gpsIfd = 0;
      const n = u16(ifd0);
      for (let i = 0; i < n; i++) { const e = ifd0 + 2 + i * 12; if (u16(e) === 0x8825) gpsIfd = tiff + u32(e + 8); }
      if (!gpsIfd) return null;
      const rat = (p: number) => { const o = tiff + u32(p + 8); return [0, 1, 2].map((k) => u32(o + k * 8) / (u32(o + k * 8 + 4) || 1)); };
      let latRef = 'N', lngRef = 'E', lat: number[] | null = null, lng: number[] | null = null;
      const m = u16(gpsIfd);
      for (let i = 0; i < m; i++) {
        const e = gpsIfd + 2 + i * 12; const tag = u16(e);
        if (tag === 1) latRef = String.fromCharCode(v.getUint8(e + 8));
        if (tag === 2) lat = rat(e);
        if (tag === 3) lngRef = String.fromCharCode(v.getUint8(e + 8));
        if (tag === 4) lng = rat(e);
      }
      if (!lat || !lng) return null;
      const dms = ([d, mi, s]: number[]) => d + mi / 60 + s / 3600;
      return { lat: dms(lat) * (latRef === 'S' ? -1 : 1), lng: dms(lng) * (lngRef === 'W' ? -1 : 1) };
    }
    off += 2 + len;
  }
  return null;
}

/** Downscale to ≤ maxWidth JPEG for upload. */
export async function compressImage(file: Blob, maxWidth = 1280, quality = 0.8): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bmp.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob((b) => res(b ?? file), 'image/jpeg', quality));
}
