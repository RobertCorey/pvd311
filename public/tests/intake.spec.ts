import { test, expect, Page } from '@playwright/test';

// AI intake card on the Review step. The Worker route is mocked; the page
// itself talks to the real Firebase project (localhost is allow-listed).
test.use({ viewport: { width: 390, height: 844 } });

async function mockIntake(page: Page, reply: (body: any) => object) {
  await page.route('**/api/intake', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply(body)) });
  });
}

async function toReview(page: Page, category = 'pothole') {
  await page.goto('/');
  await page.waitForSelector('.category-btn');
  await page.click(`[data-category="${category}"]`);
  await page.waitForSelector('[data-step="1"].active');
  await page.evaluate(() => { (window as any).photoDataUrl = 'data:image/jpeg;base64,/9j/4AAQ'; (window as any).goToStep(2); });
  await page.fill('#addressInput', '25 Dorrance St');
  await page.click('#nextBtn');
  await page.waitForSelector('[data-step="3"].active');
}

test('no description → no intake call, card hidden', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/intake', (r) => { calls++; r.fulfill({ status: 200, body: '{}' }); });
  await toReview(page);
  await page.waitForTimeout(500);
  expect(calls).toBe(0);
  await expect(page.locator('#intakeCard')).toBeHidden();
});

test('suggestion + wording: switch category, apply/undo wording, payload carries original', async ({ page }) => {
  await mockIntake(page, (b) => ({
    suggestedCategory: b.category === 'pothole' ? 'street_light' : null,
    polishedDescription: 'Street light out at 25 Dorrance St; dark at night.',
    flags: [], note: null,
  }));
  await toReview(page);
  await page.fill('#descriptionInput', 'light out');
  const card = page.locator('#intakeCard');
  await expect(card.locator('button[data-action="switch"]')).toBeVisible({ timeout: 5000 });
  await card.locator('button[data-action="switch"]').click();
  await expect(page.locator('#reviewCategory')).toHaveText('Street light out');
  expect((await page.evaluate(() => (window as any).buildPayload())).category).toBe('street_light');
  await expect(card.locator('button[data-action="switch"]')).toHaveCount(0);

  await card.locator('button[data-action="wording"]').click();
  await expect(page.locator('#descriptionInput')).toHaveValue('Street light out at 25 Dorrance St; dark at night.');
  const payload = await page.evaluate(() => (window as any).buildPayload());
  expect(payload.description).toBe('Street light out at 25 Dorrance St; dark at night.');
  expect(payload.descriptionOriginal).toBe('light out');
  expect(payload.intakeFlags).toBeUndefined();

  await card.locator('button[data-action="wording"]').click(); // undo
  await expect(page.locator('#descriptionInput')).toHaveValue('light out');
  const payload2 = await page.evaluate(() => (window as any).buildPayload());
  expect(payload2.descriptionOriginal).toBeUndefined();
});

test('emergency flag → red notice and intakeFlags in payload', async ({ page }) => {
  await mockIntake(page, () => ({ suggestedCategory: null, polishedDescription: null, flags: ['emergency', 'bogus'], note: 'If someone is hurt, call 911.' }));
  await toReview(page, 'missed_trash');
  await page.fill('#descriptionInput', 'someone is hurt');
  await expect(page.locator('#intakeCard .intake-notice.emergency')).toContainText('call 911', { timeout: 5000 });
  const payload = await page.evaluate(() => (window as any).buildPayload());
  expect(payload.intakeFlags).toEqual(['emergency']);
});

test('intake failure never blocks: card hides, payload clean', async ({ page }) => {
  await page.route('**/api/intake', (r) => r.fulfill({ status: 500, body: 'nope' }));
  await toReview(page, 'missed_trash');
  await page.fill('#descriptionInput', 'bins not picked up');
  await page.waitForTimeout(2000);
  await expect(page.locator('#intakeCard')).toBeHidden();
  const payload = await page.evaluate(() => (window as any).buildPayload());
  expect(payload.intakeFlags).toBeUndefined();
  expect(payload.descriptionOriginal).toBeUndefined();
});
