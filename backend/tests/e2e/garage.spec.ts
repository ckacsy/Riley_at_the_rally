import { test, expect } from '@playwright/test';

/**
 * Garage UI tests.
 *
 * Validates that the /garage page renders the car title element and that
 * the livery carousel switches the displayed title when a thumbnail is clicked.
 * These tests run against the DOM/HTML layer and do not depend on WebGL rendering.
 */

const CAROUSEL_TIMEOUT = 20_000;
const TITLE_TIMEOUT = 20_000;

test.describe('Garage UI', () => {
  test('page loads and shows initial car title', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');

    // The car title element must exist in the DOM
    const title = page.locator('#car-title');
    await expect(title).toBeVisible({ timeout: CAROUSEL_TIMEOUT });

    // Initial title: just ensure it becomes non-empty (some builds append livery later)
    await expect(title).toHaveText(/.+/, { timeout: TITLE_TIMEOUT });
  });

  test('carousel switches livery — title updates on thumbnail click', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');

    // Wait for the carousel to be rendered by JavaScript
    await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });

    const title = page.locator('#car-title');
    await expect(title).toBeVisible();

    // Click the second thumbnail (index 1 → variant "Синий")
    const thumbs = page.locator('.car-thumb');
    await thumbs.nth(1).click();

    // Title must now reflect the selected variant
    await expect(title).toContainText('Синий', { timeout: TITLE_TIMEOUT });
    await expect(title).toContainText('Riley-X1');
  });

  test('carousel shows five livery thumbnails', async ({ page }) => {
    await page.goto('/garage?forceFallback=1');
    await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });
    const thumbs = page.locator('.car-thumb');
    await expect(thumbs).toHaveCount(5);
  });

  // Verify all five variants update the title correctly
  const VARIANTS: Array<{ index: number; name: string }> = [
    { index: 0, name: 'Алый' },
    { index: 1, name: 'Синий' },
    { index: 2, name: 'Зелёный' },
    { index: 3, name: 'Золотой' },
    { index: 4, name: 'Чёрный' },
  ];

  for (const { index, name } of VARIANTS) {
    test(`clicking thumbnail ${index} sets ${name} variant`, async ({ page }) => {
      await page.goto('/garage?forceFallback=1');
      await page.waitForSelector('.car-thumb', { timeout: CAROUSEL_TIMEOUT });
      await page.locator('.car-thumb').nth(index).click();
      await expect(page.locator('#car-title')).toContainText(name, { timeout: TITLE_TIMEOUT });
    });
  }
});
