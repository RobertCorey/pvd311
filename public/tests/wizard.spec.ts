import { test, expect, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Firebase before page scripts run. The real SDK loads from a CDN and
// calls a restricted API key on init; without this the app would throw an
// uncaught exception on load, which our "no pageerror" test must not tolerate.
// (Same shape as location-step.spec.ts.)
// ---------------------------------------------------------------------------
const firebaseMock = `
  window.firebase = {
    initializeApp() {},
    firestore() {
      return {
        collection() {
          return {
            add() { return Promise.resolve({ id: 'mock-id' }); }
          };
        }
      };
    },
    storage() {
      return {
        ref() {
          return {
            putString() { return Promise.resolve(); },
            getDownloadURL() { return Promise.resolve('https://firebasestorage.googleapis.com/mock-photo.jpg'); }
          };
        }
      };
    },
    analytics() {
      return { logEvent() {} };
    }
  };
  window.firebase.firestore.FieldValue = { serverTimestamp() { return new Date(); } };
`;

// Pin `new Date()` to a fixed month so seasonal category visibility is
// deterministic regardless of when the suite runs. VISIBLE_CATEGORIES is
// computed at module-load time, so this must run before app.js — addInitScript
// guarantees that. A Proxy construct-trap keeps `new Date(args)`, instanceof,
// and Date.now intact. month is 0-based (0 = Jan/winter, 6 = Jul/summer).
function fakeMonthScript(month: number): string {
  return `(() => {
    const RealDate = Date;
    const fixedTime = new RealDate(2026, ${month}, 15, 12, 0, 0).getTime();
    window.Date = new Proxy(RealDate, {
      construct(target, args) {
        return args.length === 0 ? new target(fixedTime) : new target(...args);
      }
    });
  })();`;
}

// Minimal valid 1x1 PNG (no EXIF GPS) — satisfies the photo step.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==';

// Derive the expected sets from the generated registry so adding a category
// to shared/categories.ts (then `node scripts/gen-categories.mjs`) never
// breaks this spec.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const CATEGORIES: Array<{ key: string; seasonal: string | null }> = (() => {
  const src = readFileSync(join(__dirname, '..', 'categories.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('['), src.lastIndexOf(']') + 1));
})();
const NON_SEASONAL_KEYS = CATEGORIES.filter(c => !c.seasonal).map(c => c.key);
const SEASONAL_KEYS = CATEGORIES.filter(c => c.seasonal === 'winter').map(c => c.key);

async function setup(page: Page, opts: { month?: number } = {}) {
  await page.addInitScript(firebaseMock);
  // Default to July (summer) so seasonal categories are hidden unless a test
  // explicitly asks for winter.
  await page.addInitScript(fakeMonthScript(opts.month ?? 6));
  await page.goto('/');
  await page.waitForSelector('.category-btn');
}

async function uploadPhoto(page: Page) {
  const buffer = Buffer.from(PNG_BASE64, 'base64');
  await page.setInputFiles('#photoInput', {
    name: 'test.png',
    mimeType: 'image/png',
    buffer,
  });
  await page.waitForSelector('.photo-capture-btn.has-photo');
}

// Pick a photo-required category (pothole), attach a photo, and walk to Review.
async function advanceToReviewWithPhoto(page: Page, category = 'pothole') {
  await page.click(`[data-category="${category}"]`);
  await page.waitForSelector('[data-step="1"].active');
  await uploadPhoto(page);
  await expect(page.locator('#nextBtn')).toBeEnabled();
  await page.click('#nextBtn');
  await page.waitForSelector('[data-step="2"].active');
  await page.fill('#addressInput', '25 Dorrance St');
  await page.click('#nextBtn');
  await page.waitForSelector('[data-step="3"].active');
}

// Pick a photo-optional category, skip the photo, and walk to Review.
async function advanceToReviewSkipPhoto(page: Page, category = 'missed_trash') {
  await page.click(`[data-category="${category}"]`);
  await page.waitForSelector('[data-step="1"].active');
  await expect(page.locator('#nextBtn')).toHaveText('Skip photo');
  await page.click('#nextBtn');
  await page.waitForSelector('[data-step="2"].active');
  await page.fill('#addressInput', '25 Dorrance St');
  await page.click('#nextBtn');
  await page.waitForSelector('[data-step="3"].active');
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe('Category picker & seasonal hiding', () => {
  test('summer — renders non-seasonal categories, hides winter ones, unsure spans row', async ({ page }) => {
    await setup(page, { month: 6 }); // July

    for (const k of NON_SEASONAL_KEYS) {
      await expect(page.locator(`[data-category="${k}"]`)).toBeVisible();
    }
    for (const k of SEASONAL_KEYS) {
      await expect(page.locator(`[data-category="${k}"]`)).toHaveCount(0);
    }
    await expect(page.locator('.category-btn')).toHaveCount(NON_SEASONAL_KEYS.length);

    // The "Something else" (unsure) button spans the full 2-column row.
    const unsure = page.locator('.category-btn-unsure');
    await expect(unsure).toHaveAttribute('data-category', 'unsure');
    const unsureBox = await unsure.boundingBox();
    const potholeBox = await page.locator('[data-category="pothole"]').boundingBox();
    expect(unsureBox).not.toBeNull();
    expect(potholeBox).not.toBeNull();
    // A full-row button is ~2x the width of a half-row one (2fr grid + gap).
    expect(unsureBox!.width).toBeGreaterThan(potholeBox!.width * 1.5);
  });

  test('winter — seasonal categories appear', async ({ page }) => {
    await setup(page, { month: 0 }); // January

    for (const k of SEASONAL_KEYS) {
      await expect(page.locator(`[data-category="${k}"]`)).toBeVisible();
    }
    await expect(page.locator('.category-btn')).toHaveCount(
      NON_SEASONAL_KEYS.length + SEASONAL_KEYS.length,
    );
  });
});

test.describe('Photo gate', () => {
  test('pothole (photoRequired) — Next disabled on photo step', async ({ page }) => {
    await setup(page);
    await page.click('[data-category="pothole"]');
    await page.waitForSelector('[data-step="1"].active');

    await expect(page.locator('#nextBtn')).toHaveText('Next');
    await expect(page.locator('#nextBtn')).toBeDisabled();
  });

  test('missed_trash (photoRequired:false) — "Skip photo" enabled', async ({ page }) => {
    await setup(page);
    await page.click('[data-category="missed_trash"]');
    await page.waitForSelector('[data-step="1"].active');

    await expect(page.locator('#nextBtn')).toHaveText('Skip photo');
    await expect(page.locator('#nextBtn')).toBeEnabled();
  });
});

test.describe('Per-category extra questions', () => {
  test('pothole — size select renders and collectExtra() reflects selection', async ({ page }) => {
    await setup(page);
    await advanceToReviewWithPhoto(page, 'pothole');

    await expect(page.locator('#extraQuestions')).toBeVisible();
    const size = page.locator('#extra_size');
    await expect(size).toBeVisible();
    await expect(page.locator('#extra_size option')).toHaveText([
      'Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown',
    ]);

    await size.selectOption('Large (~36in)');
    const extra = await page.evaluate(() => (window as any).collectExtra());
    expect(extra).toEqual({ size: 'Large (~36in)' });
  });

  test('missed_trash — no extra questions section', async ({ page }) => {
    await setup(page);
    await advanceToReviewSkipPhoto(page, 'missed_trash');

    await expect(page.locator('#extraQuestions')).toBeHidden();
    const extra = await page.evaluate(() => (window as any).collectExtra());
    expect(extra).toBeNull();
  });
});

test.describe('Review step', () => {
  test('shows email and name inputs', async ({ page }) => {
    await setup(page);
    await advanceToReviewWithPhoto(page, 'pothole');

    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#nameInput')).toBeVisible();
  });
});

test.describe('No uncaught exceptions', () => {
  test('full flow raises no pageerror', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await setup(page);
    await advanceToReviewWithPhoto(page, 'pothole');

    // Submit and let the flow settle. Depending on whether the real Firebase
    // SDK loads (its restricted key fails here), submit ends either on the
    // confirmation screen or on the error banner — both are handled paths, not
    // uncaught exceptions.
    await expect(page.locator('#nextBtn')).toHaveText('Submit Report');
    await page.click('#nextBtn');
    await expect(
      page.locator('#confirmationScreen.visible, #errorBanner.visible'),
    ).toBeVisible();

    // Console errors from Firebase/network are tolerated; uncaught exceptions are not.
    expect(pageErrors).toEqual([]);
  });
});
