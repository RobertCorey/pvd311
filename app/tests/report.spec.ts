import { test, expect, type Page } from '@playwright/test';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'email' };

async function mockApi(page: Page, opts: { intake?: object; reportStatus?: number; reportBody?: object; signedIn?: boolean } = {}) {
  if (opts.signedIn !== false) await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/intake`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.intake ?? { polishedDescription: null, flags: [], note: null, model: 'mock' }) }));
  await page.route(`${API}/api/report`, (r) => r.fulfill({ status: opts.reportStatus ?? 201, contentType: 'application/json', body: JSON.stringify(opts.reportBody ?? { id: 'abc123xyz', trackingUrl: '/r/abc123xyz', category: 'missed_trash', createdAt: new Date().toISOString() }) }));
  await page.route(`${API}/api/reports/*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abc123xyz', category: 'missed_trash', categoryLabel: 'Missed Trash Day Pick-up Issue', address: '25 Dorrance St', lat: null, lng: null, photoUrl: null, createdAt: new Date().toISOString(), status: 'received', portalCaseId: null, portalStatus: null, timeline: [{ at: new Date().toISOString(), label: 'Received' }], nextUpdateHint: null }) }));
  await page.route('https://geocode.arcgis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ address: '25 Dorrance St', location: { x: -71.4129, y: 41.8241 }, score: 100, attributes: { Match_addr: '25 Dorrance St, Providence, RI' } }] }) }));
}

/** Pick through the group (the only chip is "Last used", absent on a fresh visit). */
async function pickType(page: import('@playwright/test').Page, group: string, key: string) {
  await page.click(`.cat-tile[data-group="${group}"]`);
  await page.click(`.type-row[data-category="${key}"]`);
}

/** A blocked Send must look plainly off (grey fill, no shadow, not-allowed cursor), be announced as disabled, and keep an AA-readable label. */
async function expectSendLooksDisabled(page: Page, disabled: boolean) {
  const send = page.locator('.submit-bar button[type="submit"]');
  await expect(send).toHaveAttribute('aria-disabled', String(disabled));
  await expect(async () => { // the colours transition (0.15 s): poll until settled
    const st = await send.evaluate((el) => {
      const cs = getComputedStyle(el);
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const [a, b] = [lum(rgb(cs.backgroundColor)), lum(rgb(cs.color))];
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, cursor: cs.cursor, opacity: cs.opacity, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
    if (disabled) expect(st).toMatchObject({ bg: 'rgb(227, 218, 203)', shadow: 'none', cursor: 'not-allowed', opacity: '1' });
    else { expect(st.bg).toBe('rgb(244, 101, 42)'); expect(st.cursor).toBe('pointer'); expect(st.shadow).not.toBe('none'); }
    expect(st.ratio).toBeGreaterThanOrEqual(4.5); // WCAG AA, normal-size text
  }).toPass({ timeout: 3000 });
}

test('picker: title + search + groups first (no chips on a fresh visit); a group drills into text rows; the wide Not-sure tile files unsure', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('.quick-chip')).toHaveCount(0); // nothing above the grid until there is a last-used type
  await expect(page.locator('.hero-sub, .trust-line')).toHaveCount(0); // entry point = title, search, tiles
  await expect(page.locator('.cat-tile[data-group]')).toHaveCount(10); // 9 groups + the wide Not-sure tile (snow types fold into Streets in season)
  await expect(page.locator('.cat-tile .cat-icon svg')).toHaveCount(10); // icons live on the tiles only
  await page.click('.cat-tile[data-group="trash"]');
  await expect(page.locator('.type-row[data-category="missed_trash"]')).toBeVisible();
  await expect(page.locator('.type-row[data-object="trash_ground"]')).toBeVisible(); // private/public collapse into one row
  await expect(page.locator('.type-row[data-category="trash_private"]')).toHaveCount(0);
  await expect(page.locator('.type-row .type-icon')).toHaveCount(0); // text rows, no icon column
  await expect(page.locator('.type-row[data-category="dpw_general"]')).toBeVisible(); // "Something else in Trash & recycling"
  await expect(page).toHaveURL(/g=trash/);
  await page.goBack(); // phone Back returns to the groups, not out of the app
  await expect(page.locator('.cat-tile[data-group="trash"]')).toBeVisible();
  await page.click('.cat-tile--wide[data-category="unsure"]');
  await expect(page.locator('#address')).toBeVisible();
});

test('picker: a row with siblings asks one facet question; Back walks question → rows → groups', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.click('.cat-tile[data-group="property"]');
  await page.click('.type-row[data-object="graffiti"]');
  await expect(page).toHaveURL(/o=graffiti/);
  await expect(page.getByRole('heading', { name: 'Where is it?' })).toHaveCount(0); // the question is the hero sub, h1 is the object
  await expect(page.locator('.facet-card[data-category]')).toHaveCount(3); // city / private / park
  await expect(page.locator('.facet-card[data-category="graffiti_park"] .type-city')).toHaveText('Graffiti in a Park');
  await page.goBack();
  await expect(page.locator('.type-row[data-object="graffiti"]')).toBeVisible();
  await page.goForward();
  await page.click('.facet-card[data-category="graffiti_private"]');
  await expect(page).toHaveURL(/c=graffiti_private/);
  await expect(page.locator('.chosen .chip')).toContainText('Graffiti on private property');
});

test('picker: search finds a type by synonym or by the city\'s own name and files it directly', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.fill('#type-search', 'lamp post');
  await expect(page.locator('.type-results .type-row[data-category="streetlight_pole"]')).toBeVisible();
  await expect(page.locator('.type-results .type-row[data-category="streetlight_pole"] .type-city')).toHaveText('Report a Leaning City Streetlight Pole');
  await page.fill('#type-search', 'catch basin');
  await expect(page.locator('.type-results .type-row[data-category="storm_drain"]')).toBeVisible();
  await page.fill('#type-search', 'zzzz');
  await expect(page.locator('.type-none')).toBeVisible();
  await expect(page.locator('.type-results [data-category="unsure"]')).toBeVisible(); // the escape hatch is always there
  await page.fill('#type-search', 'rats');
  await page.click('.type-results .type-row[data-category="rodents"]');
  await expect(page.locator('#address')).toBeVisible();
});

test('picker: the search box keeps focus while typing (no remount → the phone keyboard stays up)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  const box = page.locator('#type-search');
  await box.click();
  await page.keyboard.type('la');
  await expect(page.locator('.type-results')).toBeVisible();
  await expect(box).toBeFocused();
  await page.keyboard.type('mp post');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('lamp post');
  await expect(page.locator('.type-results .type-row[data-category="streetlight_pole"]')).toBeVisible();
  // Same from inside a group.
  await page.goto('/?g=streets');
  await page.locator('#type-search').click();
  await page.keyboard.type('rats');
  await expect(page.locator('#type-search')).toBeFocused();
  await expect(page.locator('.type-results .type-row[data-category="rodents"]')).toBeVisible();
});

test('picker remembers the last type as a quick pick', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.click('.cat-tile[data-group="trees"]');
  await page.click('.type-row[data-category="tree"]');
  await expect(page.locator('#address')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.quick-chip--last[data-category="tree"]')).toBeVisible();
});

test('city question asked in the app (noise → "Where is the noise coming from?"): the answer is sent as the city\'s own option', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'nuisance', 'noise');
  const q = page.getByLabel('Where is the noise coming from?');
  await expect(q).toBeVisible();
  await expect(q.locator('option')).toHaveText(['Choose…', 'House', 'Business (add name to description)', 'Car', 'Park (add name to description)', 'Other (add to description)']);
  await q.selectOption('Car');
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  const [req] = await Promise.all([page.waitForRequest(`${API}/api/report`), page.getByRole('button', { name: 'Send to Providence 311' }).click()]);
  expect(req.postData() ?? '').toContain('{"noiseSource":"Car"}');
});

test('city question in Spanish: labels and choices translated, the value sent is still the city\'s option', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'property', 'substandard_housing');
  const q = page.getByLabel('¿El problema está dentro o fuera del edificio?');
  await expect(q.locator('option[value="Internal"]')).toHaveText('Dentro');
  await expect(page.getByLabel('Nombre y teléfono del dueño o casero (si los sabes)')).toBeVisible();
});

test('photo-optional category: address → submit → tracking page (no bot check: the sign-in is the check)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await expect(page.getByRole('heading', { name: /Add a photo \(optional\)/ })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Send to Providence 311' });
  await expect(submit).toBeDisabled();
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  await expect(submit).toBeEnabled();
  const [req] = await Promise.all([page.waitForRequest(`${API}/api/report`), submit.click()]);
  const body = req.postData() ?? '';
  expect(body).toContain('name="category"');
  expect(body).toContain('missed_trash');
  expect(body).not.toContain('turnstileToken');
  expect(req.headers()['authorization']).toBe('Bearer tok');
  expect(body).toMatch(/name="clientId"\r?\n\r?\n[0-9a-f-]{36}/);
  await expect(page).toHaveURL(/\/r\/abc123xyz$/);
});

test('chip → Change returns to the grid and clears extras', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'streets', 'pothole');
  await expect(page.locator('#extra_size')).toBeVisible();
  await page.getByRole('button', { name: /Change/ }).click();
  await expect(page.locator('.cat-tile[data-group="streets"]')).toBeVisible();
});

test('photo-required category keeps submit disabled without a photo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'streets', 'pothole');
  await page.fill('#address', '25 Dorrance St');
  await expect(page.getByRole('button', { name: 'Send to Providence 311' })).toBeDisabled();
  await expect(page.locator('#extra_size')).toBeVisible();
});

test('intake: emergency notice + wording apply/undo', async ({ page }) => {
  await mockApi(page, { intake: { polishedDescription: 'Trash not collected at 25 Dorrance St on Tuesday.', flags: ['emergency'], note: 'If someone is hurt, call 911.' } });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#description', 'trash not picked up tuesday');
  await expect(page.locator('.notice-error')).toContainText('call 911', { timeout: 6000 });
  await page.getByRole('button', { name: 'Use this wording' }).click();
  await expect(page.locator('#description')).toHaveValue('Trash not collected at 25 Dorrance St on Tuesday.');
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(page.locator('#description')).toHaveValue('trash not picked up tuesday');
});

test('rate limited → friendly message, stays on page', async ({ page }) => {
  await mockApi(page, { reportStatus: 429, reportBody: { error: 'rate_limited', retryAfterSec: 120 } });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('[role="alert"]')).toContainText('One report at a time');
  await expect(page).toHaveURL(/\/\?c=missed_trash$/); // still on the report page, draft intact
});

test('offline: submit queues to outbox, shows saved screen; back online it flushes', async ({ page, context }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  // 15 s like the flush below: under the full suite's load (8 workers, the map specs) the offline save can take > 5 s.
  await expect(page.locator('.queued')).toContainText('Saved on your phone', { timeout: 15_000 });
  await context.setOffline(false);
  const flushed = page.waitForRequest(`${API}/api/report`);
  await page.goto('/');
  await flushed;
  await expect(page.locator('.notice-ok')).toContainText('Sent a saved report', { timeout: 15_000 });
  await expect(page.locator('.outbox-card')).toHaveCount(0);
});

test('language switch to Español persists and translates the picker', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Español' }).click();
  await expect(page.getByRole('heading', { name: '¿Cuál es el problema?' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '¿Cuál es el problema?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('es');
});

test('typed address geocodes → mini-map with draggable pin appears', async ({ page }) => {
  await mockApi(page);
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  await expect(page.locator('.mini-map .leaflet-container')).toBeVisible({ timeout: 10_000 });
  const pin = page.locator('.mini-map .leaflet-marker-draggable');
  await expect(pin).toHaveCount(1);
  // Drag the pin: Leaflet's dragend reaches onPinMove, which announces the move and re-centres the map on the new spot.
  // (Scroll the map to mid-screen first: the fixed submit bar would otherwise sit over the pin and take the pointer.)
  await page.evaluate(() => document.querySelector('.mini-map')!.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const before = (await pin.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 36, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('p.hint[aria-live="polite"]', { hasText: 'Pin moved' })).toHaveText('Pin moved — address updated.');
  // The controlled `center` followed the pin: its tip sits back at the map's centre (the map box is re-read: the
  // "Pin moved" line above it shifts the map down).
  await expect.poll(async () => {
    const map = (await page.locator('.mini-map .leaflet-container').boundingBox())!;
    const b = (await pin.boundingBox())!;
    return Math.max(Math.abs(b.x + b.width / 2 - (map.x + map.width / 2)), Math.abs(b.y + 38 - (map.y + map.height / 2)));
  }, { timeout: 5_000 }).toBeLessThan(4);
});

test('dedupe: nearby match shows the prompt with a tracking link; dismiss hides it', async ({ page }) => {
  await mockApi(page);
  await page.route(`${API}/api/nearby*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
    { id: 'near1', source: 'ours', category: 'missed_trash', categoryLabel: 'Missed Trash Day Pick-up Issue', lat: 41.8241, lng: -71.4129, address: '27 Dorrance St, Providence, RI', createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), status: 'sent', portalStatus: 'Submitted', distanceM: 18 },
  ] }) }));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  const card = page.locator('.nearby-card');
  await expect(card).toContainText('Already reported nearby', { timeout: 10_000 });
  await expect(card).toContainText('27 Dorrance St, 2 days ago — 18 m');
  await expect(card.getByRole('link', { name: 'View that report' })).toHaveAttribute('href', '/r/near1');
  await card.getByRole('button', { name: 'Report anyway' }).click();
  await expect(card).toHaveCount(0);
});

test('cold offline start: can queue a report', async ({ page, context }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const submit = page.getByRole('button', { name: 'Send to Providence 311' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('.queued')).toContainText('Saved on your phone');
});

test('flush failure pauses retries instead of looping (no second request until an online event)', async ({ page }) => {
  await mockApi(page);
  let calls = 0;
  await page.route(`${API}/api/report`, (r) => { calls++; r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', retryAfterSec: 600 }) }); });
  await page.goto('/');
  // Seed one queued item directly (avoids the harness's synthetic offline/online events).
  await page.evaluate(() => new Promise<void>((done) => {
    const r = indexedDB.open('fixmypvd', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => {
      const tx = r.result.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').add({ queuedAt: Date.now(), clientId: 'seed-1', attempts: 0, report: { category: 'missed_trash', description: '', address: '25 Dorrance St', lat: null, lng: null, extra: null, photo: null } });
      tx.oncomplete = () => done();
    };
  }));
  await page.reload();
  await expect(page.locator('.outbox-card')).toContainText('1 saved report');
  await page.waitForTimeout(2500);
  expect(calls).toBe(1);
  // A real reconnect resumes exactly one more attempt.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2000);
  expect(calls).toBe(2);
});

test('signed out: Send parks the draft and shows the sign-in gate; after sign-in the draft is restored', async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.fill('#description', 'bins not collected');
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.gate-slot')).toBeVisible();
  await expect(page.locator('.submit-bar')).toBeHidden();
  // "Sign in" (seed a session) and come back — the draft survives the round trip.
  await page.evaluate((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.goto('/?resume=1');
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St');
  await expect(page.locator('#description')).toHaveValue('bins not collected');
  await expect(page.locator('.submit-bar')).toContainText("You're signed in");
  const [req] = await Promise.all([page.waitForRequest(`${API}/api/report`), page.getByRole('button', { name: 'Send to Providence 311' }).click()]);
  expect(req.headers()['authorization']).toBe('Bearer tok');
  await expect(page).toHaveURL(/\/r\/abc123xyz$/);
});

// 2026-10-20 lost report (mobile): sign-in round trip with a photo, then three Sends all failed with a bare
// client TypeError. On WebKit a Blob read from IndexedDB stays backed by the record, and the compose autosave
// rewrote that record ~800 ms after restore, so fetch could not read the body. The restore now
// copies the photo into memory; Playwright's WebKit can't store Blobs in IDB, so these run on Chromium.
async function parkWithPhotoAndResume(page: Page) {
  await mockApi(page, { signedIn: false });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.setInputFiles('#photoLibrary', { name: 'photo.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await expect(page.locator('.photo-preview img')).toBeVisible();
  await page.fill('#address', '25 Dorrance St');
  await page.fill('#description', 'bins not collected');
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.gate-slot')).toBeVisible();
  await page.evaluate((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.goto('/?resume=1');
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St');
  await expect(page.locator('.photo-preview img')).toBeVisible();
  await page.waitForTimeout(1500); // the compose autosave rewrites the parked record
}

test('signed out with a photo: after sign-in and an autosave tick, Send still uploads the photo', async ({ page }) => {
  await parkWithPhotoAndResume(page);
  const [req] = await Promise.all([page.waitForRequest(`${API}/api/report`), page.getByRole('button', { name: 'Send to Providence 311' }).click()]);
  expect(req.postDataBuffer()?.includes('name="photo"')).toBe(true);
  await expect(page).toHaveURL(/\/r\/abc123xyz$/);
});

test('an unreadable photo at Send (dead IndexedDB Blob) asks for the photo again instead of failing blind', async ({ page }) => {
  await parkWithPhotoAndResume(page);
  let posted = false;
  page.on('request', (r) => { if (r.url() === `${API}/api/report`) posted = true; });
  await page.evaluate(() => { Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException('gone', 'NotReadableError')); });
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.getByText("Your photo didn't come through")).toBeVisible();
  await expect(page.locator('.photo-preview')).toHaveCount(0); // photo step is back
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St'); // rest of the draft kept
  expect(posted).toBe(false);
});

// Sentry JAVASCRIPT-8 (2026-10-16, DuckDuckGo on iOS): IndexedDB is stubbed. Signed-out Send must still reach
// the sign-in gate — no uncaught error, no hang — whether the stub hands back no result or never answers at all.
for (const [name, stub] of [
  ['upgradeneeded with result undefined', 'upgrade-undefined'],
  ['a request that never fires any event', 'silent'],
] as const) {
  test(`stubbed IndexedDB (${name}): signed-out Send still shows the sign-in gate, no page error`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((mode) => {
      const fake = () => {
        const req: Record<string, unknown> = { result: undefined, error: null, transaction: null };
        if (mode === 'upgrade-undefined') setTimeout(() => (req.onupgradeneeded as (() => void) | undefined)?.(), 0);
        return req;
      };
      Object.defineProperty(window.indexedDB, 'open', { value: fake, configurable: true });
    }, stub);
    await mockApi(page, { signedIn: false });
    await page.goto('/');
    await pickType(page, 'trash', 'missed_trash');
    await page.fill('#address', '25 Dorrance St');
    await page.fill('#description', 'bins not collected');
    await page.getByRole('button', { name: 'Send to Providence 311' }).click();
    await expect(page.locator('.gate-slot')).toBeVisible({ timeout: 8_000 });
    expect(errors.filter((m) => /objectStoreNames|indexeddb/i.test(m))).toEqual([]);
  });
}

test('a plain visit to / does not resurrect an abandoned draft', async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.gate-slot')).toBeVisible();
  await page.goto('/');
  await expect(page.locator('.cat-tile[data-group="trash"]')).toBeVisible();
  await expect(page.locator('#address')).toHaveCount(0);
});

test('signed out + offline: Send queues to the outbox instead of gating', async ({ page, context }) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.queued')).toContainText('Saved on your phone');
});

test('phone Back from the compose step walks type list → groups (group + category live in the URL)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await expect(page).toHaveURL(/\?c=missed_trash$/);
  await page.fill('#address', '25 Dorrance St');
  await page.goBack(); // → the group's type list
  await expect(page).toHaveURL(/g=trash/);
  await expect(page.locator('.type-row[data-category="missed_trash"]')).toBeVisible();
  await page.goBack(); // → the groups
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.cat-tile[data-group="trash"]')).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St'); // draft kept in memory
});

test('disabled Send explains what is missing, in order', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'streets', 'pothole');
  await expect(page.getByRole('heading', { name: 'Add a photo (required)' })).toBeVisible();
  await expect(page.locator('.submit-bar .hint')).toHaveText('Add a photo to send.');
  await expectSendLooksDisabled(page, true);
  await page.getByRole('button', { name: 'Send to Providence 311' }).click({ force: true }); // a tap on the grey button just keeps explaining
  await expect(page.locator('.submit-bar .hint')).toHaveText('Add a photo to send.');
  await expect(page).toHaveURL(/c=pothole/);
  await page.evaluate(() => { /* no file chooser in headless: fall back to a photo-optional category check below */ });
  await page.getByRole('button', { name: /Change/ }).click();
  await pickType(page, 'trash', 'missed_trash');
  await expect(page.locator('.submit-bar .hint')).toHaveText('Add the address to send.');
  await expectSendLooksDisabled(page, true);
  await page.fill('#address', '25 Dorrance St');
  await expect(page.locator('.submit-bar .hint')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send to Providence 311' })).toBeEnabled();
  await expectSendLooksDisabled(page, false);
});

// A valid 1x1 PNG (green pixel), and a non-image, for the photo-validation tests.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

test('no sign-in disclosure on compose — the gate appears only at Send', async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await expect(page.locator('.signin-disclosure')).toHaveCount(0);
  await expect(page.getByText(/sign-in — no password/i)).toHaveCount(0);
});

test('no human-check step: Send is ready once the photo/address are in, and nothing loads from Cloudflare', async ({ page }) => {
  await mockApi(page);
  let cf = 0;
  await page.route('https://challenges.cloudflare.com/**', (r) => { cf++; return r.abort(); });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  await expect(page.getByRole('button', { name: 'Send to Providence 311' })).toBeEnabled();
  await expect(page.getByText("Quick check that you're a person")).toHaveCount(0);
  expect(cf).toBe(0);
});

test('typed address that geocodes to nothing shows an inline check-the-street message', async ({ page }) => {
  await mockApi(page);
  await page.route('https://geocode.arcgis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [] }) }));
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', 'zzz not a real street');
  await page.locator('#address').blur();
  await expect(page.locator('.notice-warn')).toContainText("We couldn't find that address in Providence");
});

test('typed address outside Providence warns and clears once a city address geocodes', async ({ page }) => {
  await mockApi(page);
  await page.route('https://geocode.arcgis.com/**', (route) => {
    const outside = /Elsewhere/i.test(decodeURIComponent(route.request().url()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{
      location: outside ? { x: -71.30, y: 41.90 } : { x: -71.4129, y: 41.8241 }, score: 100,
      attributes: { Match_addr: outside ? 'Somewhere, RI' : '25 Dorrance St, Providence, RI' },
    }] }) });
  });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '100 Elsewhere Rd');
  await page.locator('#address').blur();
  await expect(page.locator('.notice-warn')).toContainText('You appear to be outside Providence');
  await expect(page.locator('.submit-bar .hint')).toHaveText('That location is outside Providence.');
  // Re-evaluates against the current address: a Providence address clears it.
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  await expect(page.locator('.notice-warn')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send to Providence 311' })).toBeEnabled();
});

test('photo validation: a non-image is rejected, a real image is accepted', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.setInputFiles('#photoLibrary', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('this is not a photo') });
  await expect(page.locator('.notice-error')).toContainText("That file isn't a photo.");
  await expect(page.locator('.photo-preview')).toHaveCount(0);
  await page.setInputFiles('#photoLibrary', { name: 'photo.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await expect(page.locator('.photo-preview')).toBeVisible();
  await expect(page.locator('.notice-error')).toHaveCount(0);
});

test('Send is aria-disabled (not natively disabled) and does not submit while blocked', async ({ page }) => {
  await mockApi(page);
  let reported = false;
  await page.route(`${API}/api/report`, (r) => { reported = true; r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'x', trackingUrl: '/r/x', category: 'missed_trash', createdAt: new Date().toISOString() }) }); });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  const submit = page.getByRole('button', { name: 'Send to Providence 311' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(submit).toHaveAttribute('aria-describedby', 'submit-hint');
  await expect(submit).not.toHaveAttribute('disabled', /.*/);
  // Force past the actionability guard: the onSubmit guard must still refuse.
  await submit.click({ force: true });
  await page.waitForTimeout(300);
  expect(reported).toBe(false);
  await page.fill('#address', '25 Dorrance St');
  await expect(submit).toHaveAttribute('aria-disabled', 'false');
});

test('offline queued screen tells you to sign in online to send it', async ({ page, context }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.queued')).toContainText('Saved on your phone');
  await expect(page.locator('.queued')).toContainText('sign in to send it to 311');
});

// ---- P2 #11: draft autosave across reload ----
test('reload restores an autosaved draft with a dismissible notice, photo included', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => { (window as unknown as { __DRAFT_AUTOSAVE_MS__?: number }).__DRAFT_AUTOSAVE_MS__ = 30; });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.fill('#description', 'bins not collected on my street');
  await page.setInputFiles('#photoLibrary', { name: 'photo.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await expect(page.locator('.photo-preview')).toBeVisible();
  await page.waitForTimeout(200); // let the debounced autosave persist to IndexedDB
  await page.reload();
  await expect(page.locator('.photo-preview')).toBeVisible(); // the photo survives the reload
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St');
  await expect(page.locator('#description')).toHaveValue('bins not collected on my street');
  const notice = page.locator('.restored-notice');
  await expect(notice).toContainText('Restored your draft');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.restored-notice')).toHaveCount(0);
});

test('a fresh navigation (not a reload) starts clean — no autosave resurrection', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => { (window as unknown as { __DRAFT_AUTOSAVE_MS__?: number }).__DRAFT_AUTOSAVE_MS__ = 30; });
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.waitForTimeout(200); // autosave persists
  // A deep-link to the same compose URL is a 'navigate', not a 'reload' → clean start.
  await page.goto('/?c=missed_trash');
  await expect(page.locator('#address')).toHaveValue('');
  await expect(page.locator('.restored-notice')).toHaveCount(0);
});

// ---- P2 #12: description maxlength 2000 with a counter ----
test('description shows a counter past 1,800 chars and is capped at 2,000', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  const ta = page.locator('#description');
  await expect(ta).toHaveAttribute('maxlength', '2000');
  await expect(page.locator('.char-count')).toHaveCount(0); // hidden while short
  await ta.fill('a'.repeat(1850));
  await expect(page.locator('.char-count')).toHaveText('1,850 / 2,000');
  // Real typing is stopped at the 2,000-char cap by maxlength.
  await ta.fill('b'.repeat(1998));
  await ta.pressSequentially('cccc');
  expect(await ta.evaluate((el: HTMLTextAreaElement) => el.value.length)).toBe(2000);
  await expect(page.locator('.char-count')).toHaveText('2,000 / 2,000');
});

// ---- P2 #13: emergency keyword banner, independent of the AI intake ----
test('emergency banner shows on a danger keyword (AI check silent), not on "firehouse"', async ({ page }) => {
  await mockApi(page); // intake mock returns no flags → banner must be purely client-side
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  const ta = page.locator('#description');
  await ta.fill('there is a gas leak on the corner');
  const banner = page.locator('.emergency-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('call 911');
  await expect(banner.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
  // "firehouse" is not an emergency — no false positive.
  await ta.fill('graffiti on the firehouse wall');
  await expect(page.locator('.emergency-banner')).toHaveCount(0);
});

// ── Reporter quota (docs/quota.md): the server's /api/me quota drives a quiet line / a blocked Send ──
const quota = (o: Partial<{ dayUsed: number; weekUsed: number; dayLimit: number; weekLimit: number }> = {}) => ({
  dayUsed: 0, dayLimit: 5, weekUsed: 0, weekLimit: 15, dayResetsAt: new Date(Date.now() + 3_600_000).toISOString(),
  weekResetsAt: new Date(Date.now() + 86_400_000).toISOString(), nextAllowedAt: null, raised: false, ...o,
});
async function mockMe(page: Page, q: ReturnType<typeof quota>) {
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'password', prefs: { emailUpdates: true }, addresses: [], following: [], createdAt: new Date().toISOString(), quota: q }) }));
}
async function compose(page: Page) {
  await page.goto('/');
  await pickType(page, 'trash', 'missed_trash');
  await page.fill('#address', '25 Dorrance St');
  await page.fill('#description', 'bins left out since Monday');
}

test('quota: 3 or more left → nothing shown, Send works', async ({ page }) => {
  await mockApi(page);
  await mockMe(page, quota({ dayUsed: 2, weekUsed: 2 }));
  const me = page.waitForRequest(`${API}/api/me`);
  await compose(page);
  await me;
  await page.waitForTimeout(300);
  await expect(page.locator('.quota-line, .quota-out')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send to Providence 311' })).toHaveAttribute('aria-disabled', 'false');
});

test('quota: 2 left today → one quiet line; the week wins when it runs out first', async ({ page }) => {
  await mockApi(page);
  await mockMe(page, quota({ dayUsed: 3, weekUsed: 3 }));
  await compose(page);
  await expect(page.locator('.quota-line')).toHaveText('2 reports left today · resets at midnight');
  await expectSendLooksDisabled(page, false);
  await page.unroute(`${API}/api/me`);
  await mockMe(page, quota({ dayUsed: 1, weekUsed: 14 }));
  await compose(page);
  await expect(page.locator('.quota-line')).toHaveText('1 report left this week · resets Monday');
});

test('quota: 0 left today → Send greyed + aria-disabled with the reason, no contact link, draft kept, nothing sent', async ({ page }) => {
  await mockApi(page);
  await mockMe(page, quota({ dayUsed: 5, weekUsed: 7 }));
  let posted = 0;
  page.on('request', (r) => { if (r.url() === `${API}/api/report`) posted++; });
  await compose(page);
  const send = page.getByRole('button', { name: 'Send to Providence 311' });
  await expectSendLooksDisabled(page, true);
  await expect(page.locator('.quota-out')).toHaveText('Daily limit reached (5 reports). Your draft is kept — you can send it after midnight.');
  await expect(page.locator('.submit-bar a[href^="mailto:"]')).toHaveCount(0);
  await expect(page.getByText(/Need to report more/)).toHaveCount(0);
  await expect(page.locator('.quota-line')).toHaveCount(0);
  await send.click({ force: true }); // aria-disabled: a tap must still not send
  await page.waitForTimeout(300);
  expect(posted).toBe(0);
  await expect(page.locator('#description')).toHaveValue('bins left out since Monday');
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St');
});

test('quota: a 429 rate_limited (week) shows the same blocked state and keeps the draft', async ({ page }) => {
  await mockApi(page, { reportStatus: 429, reportBody: { error: 'rate_limited', reason: 'week', retryAfterSec: 200_000, quota: quota({ dayUsed: 2, weekUsed: 15 }) } });
  await mockMe(page, quota({ dayUsed: 1, weekUsed: 14 }));
  await compose(page);
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.quota-out')).toHaveText('Weekly limit reached (15 reports). Your draft is kept — you can send it on Monday.');
  await expectSendLooksDisabled(page, true);
  await expect(page.locator('.submit-bar a[href^="mailto:"]')).toHaveCount(0);
  await expect(page.locator('.notice-error')).toHaveCount(0);
  await expect(page.locator('#description')).toHaveValue('bins left out since Monday');
  await expect(page).toHaveURL(/\/\?c=missed_trash$/);
});
