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

/**
 * Confirm a picked file is a real image by decoding it (not just trusting the
 * extension/type). Uses createImageBitmap where available, falling back to an
 * <img> load and naturalWidth > 0. Resolves false for non-images.
 */
export async function decodeImage(file: Blob): Promise<boolean> {
  if (file.type && !file.type.startsWith('image/')) return false;
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const ok = bmp.width > 0 && bmp.height > 0;
      bmp.close();
      return ok;
    } catch { /* fall back to <img> */ }
  }
  return await new Promise<boolean>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { const ok = img.naturalWidth > 0; URL.revokeObjectURL(url); resolve(ok); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
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

/**
 * Downscale + re-encode to a JPEG under `maxBytes` (the Worker stores photos in
 * Firestore on the Spark plan: 1 MB doc limit incl. base64 overhead → keep ≤300 KB).
 */
export async function compressImage(file: Blob, maxBytes = 300 * 1024, maxWidth = 1280): Promise<Blob> {
  // Bake EXIF rotation into the pixels so the upload is upright everywhere.
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  let width = maxWidth;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(1, width / bmp.width);
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.82, 0.72, 0.62, 0.5]) {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= maxBytes) { bmp.close(); return blob; }
    }
    width = Math.round(width * 0.75);
  }
  const last = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.4));
  bmp.close();
  return last ?? file;
}
