import { test, expect } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole } from './helpers';

const TEST_BASE_URL = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:5000';

/**
 * Admin UI — focused frontend tests.
 *
 * Covers:
 *  - Page access / route guards (admin and moderator can open admin pages; plain user is redirected)
 *  - Moderator can ban a user via the UI
 *  - Admin can adjust balance via the UI form
 *  - Moderator does not see the Delete button
 *  - Admin/moderator can open admin news page
 *  - Admin can create a draft news item from the UI
 *  - Markdown preview renders formatted output
 *
 * These tests exercise UI interactions only — they do not re-test backend API logic
 * already covered in admin_users.spec.ts and news.spec.ts.
 */

// ---------------------------------------------------------------------------
// Helpers (mirror the pattern from admin_users.spec.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Admin can open admin users page
// ---------------------------------------------------------------------------
test('admin can open admin users page', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'adminui1', 'adminui1@test.com');
  await activateUser(page, 'adminui1');
  await setUserRole(page, 'adminui1', 'admin');
  await loginUser(page, 'adminui1');

  await page.goto(TEST_BASE_URL + '/admin-users');
  // Should not redirect — table should appear after auth check
  await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#admin-content')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Plain user is redirected from admin page
// ---------------------------------------------------------------------------
test('plain user is redirected from admin page', async ({ page }) => {
  await resetDb(page);
  await registerUser(page, 'plainui1', 'plainui1@test.com');
  await activateUser(page, 'plainui1');
  await loginUser(page, 'plainui1');

  await page.goto(TEST_BASE_URL + '/admin-users');
  // requireAdmin redirects plain users to /garage
  await expect(page).toHaveURL(/garage/, { timeout: 8000 });
});

// ---------------------------------------------------------------------------
// 3. Moderator can ban a user from UI
// ---------------------------------------------------------------------------
test('moderator can ban a user from UI', async ({ page }) => {
  await resetDb(page);

  // Create target user
  const target = await registerUser(page, 'targetui', 'targetui@test.com');
  await activateUser(page, 'targetui');

  // Create moderator
  await registerUser(page, 'modui1', 'modui1@test.com');
  await activateUser(page, 'modui1');
  await setUserRole(page, 'modui1', 'moderator');
  await loginUser(page, 'modui1');

  await page.goto(TEST_BASE_URL + '/admin-users');
  await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

  // Find the target user's row by scanning td cells
  const targetRow = page.locator('#users-tbody tr').filter({
    has: page.locator('td', { hasText: 'targetui' }),
  }).first();
  await expect(targetRow).toBeVisible({ timeout: 5000 });

  // Handle confirm dialog
  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });

  // Click the ban button
  await targetRow.locator('button.btn-ban').click();

  // Wait for the success flash message
  await expect(page.locator('#flash-container .admin-flash--success')).toBeVisible({ timeout: 6000 });

  // The row should now show "banned" status badge
  await expect(targetRow.locator('.badge-status--banned')).toBeVisible({ timeout: 6000 });
});

// ---------------------------------------------------------------------------
// 4. Admin can adjust balance from UI
// ---------------------------------------------------------------------------
test('admin can adjust balance from UI', async ({ page }) => {
  await resetDb(page);

  const target = await registerUser(page, 'balanceui', 'balanceui@test.com');
  await activateUser(page, 'balanceui');

  await registerUser(page, 'adminui2', 'adminui2@test.com');
  await activateUser(page, 'adminui2');
  await setUserRole(page, 'adminui2', 'admin');
  await loginUser(page, 'adminui2');

  await page.goto(TEST_BASE_URL + '/admin-users');
  await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

  const targetRow = page.locator('#users-tbody tr').filter({
    has: page.locator('td', { hasText: 'balanceui' }),
  }).first();
  await expect(targetRow).toBeVisible({ timeout: 5000 });

  // Open the balance adjust modal
  await targetRow.locator('button.btn-adjust').click();
  await expect(page.locator('#modal-adjust')).toBeVisible({ timeout: 4000 });

  // Fill in the form
  await page.fill('#adjust-amount', '50');
  await page.fill('#adjust-comment', 'UI test adjustment');

  // Submit
  await page.click('#modal-adjust-submit');

  // Modal should close and flash success
  await expect(page.locator('#modal-adjust')).toBeHidden({ timeout: 6000 });
  await expect(page.locator('#flash-container .admin-flash--success')).toBeVisible({ timeout: 6000 });
});

// ---------------------------------------------------------------------------
// 5. Moderator does not see the Delete button
// ---------------------------------------------------------------------------
test('moderator does not see delete button', async ({ page }) => {
  await resetDb(page);

  await registerUser(page, 'nodelbtn', 'nodelbtn@test.com');
  await activateUser(page, 'nodelbtn');

  await registerUser(page, 'modui2', 'modui2@test.com');
  await activateUser(page, 'modui2');
  await setUserRole(page, 'modui2', 'moderator');
  await loginUser(page, 'modui2');

  await page.goto(TEST_BASE_URL + '/admin-users');
  await expect(page.locator('#users-table')).toBeVisible({ timeout: 8000 });

  // Moderator should not see any delete buttons
  await expect(page.locator('button.btn-delete')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 6. Admin can open admin news page
// ---------------------------------------------------------------------------
test('admin can open admin news page', async ({ page }) => {
  await resetDb(page);

  await registerUser(page, 'newsadmin1', 'newsadmin1@test.com');
  await activateUser(page, 'newsadmin1');
  await setUserRole(page, 'newsadmin1', 'admin');
  await loginUser(page, 'newsadmin1');

  await page.goto(TEST_BASE_URL + '/admin-news');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#btn-new-news')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 7. Admin can create a draft news item from UI
// ---------------------------------------------------------------------------
test('admin can create a draft news item from UI', async ({ page }) => {
  await resetDb(page);

  await registerUser(page, 'newsadmin2', 'newsadmin2@test.com');
  await activateUser(page, 'newsadmin2');
  await setUserRole(page, 'newsadmin2', 'admin');
  await loginUser(page, 'newsadmin2');

  await page.goto(TEST_BASE_URL + '/admin-news');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

  // Click "create new"
  await page.click('#btn-new-news');
  await expect(page.locator('#editor-form')).toBeVisible({ timeout: 4000 });

  // Fill in the form
  await page.fill('#field-title', 'UI Test Draft');
  await page.selectOption('#field-status', 'draft');
  await page.fill('#field-body', '## Hello\n\nThis is a draft from the UI test.');

  // Save
  await page.click('#btn-save');

  // Expect success flash and new item in list
  await expect(page.locator('#flash-container .admin-flash--success')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#news-list .news-item').filter({
    hasText: 'UI Test Draft',
  })).toBeVisible({ timeout: 6000 });
});

// ---------------------------------------------------------------------------
// 8. Markdown preview renders formatted output
// ---------------------------------------------------------------------------
test('markdown preview renders formatted output', async ({ page }) => {
  await resetDb(page);

  await registerUser(page, 'previewadmin', 'previewadmin@test.com');
  await activateUser(page, 'previewadmin');
  await setUserRole(page, 'previewadmin', 'admin');
  await loginUser(page, 'previewadmin');

  await page.goto(TEST_BASE_URL + '/admin-news');
  await expect(page.locator('#admin-content')).toBeVisible({ timeout: 8000 });

  // Open new editor
  await page.click('#btn-new-news');
  await expect(page.locator('#editor-form')).toBeVisible({ timeout: 4000 });

  // Type markdown content
  await page.fill('#field-body', '## Test Heading\n\n**bold** text');

  // Toggle preview
  await page.click('#btn-toggle-preview');
  await expect(page.locator('#preview-pane')).toBeVisible({ timeout: 4000 });

  // Verify rendered HTML contains expected elements
  const previewHtml = await page.locator('#preview-pane').innerHTML();
  expect(previewHtml).toContain('<h2');
  expect(previewHtml).toContain('Test Heading');
  expect(previewHtml).toContain('<strong>');
  expect(previewHtml).toContain('bold');
});
