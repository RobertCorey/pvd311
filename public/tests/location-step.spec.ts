import { test, expect, Page } from '@playwright/test';

// Mock Firebase before page loads to prevent real backend calls
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

async function setupPage(page: Page) {
  await page.addInitScript(firebaseMock);
  await page.goto('/');
}

// Select a category and advance past photo step to reach Step 2 (Location)
// Uses a tiny valid 1x1 PNG so the photo step is satisfied (no EXIF GPS).
async function advanceToLocationStep(page: Page) {
  // Step 0: pick a category
  await page.click('[data-category="pothole"]');
  // Auto-advances to step 1 after 300ms
  await page.waitForSelector('[data-step="1"].active');

  // Step 1: upload a minimal PNG (no EXIF)
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==';
  const buffer = Buffer.from(pngBase64, 'base64');

  await page.setInputFiles('#photoInput', {
    name: 'test.png',
    mimeType: 'image/png',
    buffer,
  });

  // Wait for photo to process
  await page.waitForSelector('.photo-capture-btn.has-photo');

  // Click Next to go to Step 2
  await page.click('#nextBtn');
  await page.waitForSelector('[data-step="2"].active');
}

test.describe('Location Step — State-driven layout', () => {

  test('State B — No EXIF, needs-input', async ({ page }) => {
    await setupPage(page);
    await advanceToLocationStep(page);

    await expect(page.locator('#locationHeading')).toHaveText('Set location');
    await expect(page.locator('.detect-btn-hero')).toBeVisible();
    await expect(page.locator('.location-divider')).toBeVisible();
    await expect(page.locator('#addressInput')).toBeVisible();
    await expect(page.locator('#nextBtn')).toBeDisabled();
  });

  test('State A — EXIF found, confirmed', async ({ page }) => {
    await setupPage(page);
    await advanceToLocationStep(page);

    // Simulate EXIF GPS detection
    await page.evaluate(() => {
      (window as any).currentLat = 41.824;
      (window as any).currentLng = -71.412;
      const input = document.getElementById('addressInput') as HTMLInputElement;
      input.value = '25 Dorrance St, Providence, RI';
      (window as any).setLocationState('confirmed');
      // Trigger validation
      input.dispatchEvent(new Event('input'));
    });

    await expect(page.locator('#locationHeading')).toHaveText('Confirm location');
    await expect(page.locator('.detect-btn-hero')).not.toBeVisible();
    await expect(page.locator('.location-divider')).not.toBeVisible();
    await expect(page.locator('#addressInput')).toHaveValue('25 Dorrance St, Providence, RI');
    await expect(page.locator('#nextBtn')).toBeEnabled();
  });

  test('State C — Detect GPS succeeds', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 41.824, longitude: -71.412 });

    await page.addInitScript(firebaseMock);
    await page.goto('/');
    await advanceToLocationStep(page);

    await page.click('.detect-btn-hero');

    await expect(page.locator('#locationSection')).toHaveClass(/state-confirmed/);
    await expect(page.locator('#locationHeading')).toHaveText('Confirm location');
    await expect(page.locator('#locationStatus')).toHaveText('Location detected from GPS.');
  });

  test('State D — Detect GPS fails', async ({ page }) => {
    await page.addInitScript(firebaseMock);

    // Mock geolocation to fail using Object.defineProperty
    await page.addInitScript(() => {
      const fakeGeo = {
        getCurrentPosition(_success: any, error: any) {
          error({
            code: 1,
            message: 'User denied',
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          });
        },
        watchPosition() { return 0; },
        clearWatch() {},
      };
      Object.defineProperty(navigator, 'geolocation', {
        value: fakeGeo,
        writable: true,
        configurable: true,
      });
    });

    await page.goto('/');
    await advanceToLocationStep(page);

    await page.click('.detect-btn-hero');

    await expect(page.locator('#locationSection')).toHaveClass(/state-detect-failed/);
    await expect(page.locator('.detect-btn-hero')).toBeVisible();
    await expect(page.locator('#addressInput')).toBeFocused();
    await expect(page.locator('#locationStatus')).toContainText('Could not access location');
  });

  test('Manual fallback — typing address enables Next', async ({ page }) => {
    await setupPage(page);
    await advanceToLocationStep(page);

    await expect(page.locator('#nextBtn')).toBeDisabled();

    await page.fill('#addressInput', '25 Dorrance St');

    await expect(page.locator('#nextBtn')).toBeEnabled();
  });
});
