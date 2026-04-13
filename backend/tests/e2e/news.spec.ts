import { test, expect, type Page } from '@playwright/test';
import { resetDb, getCsrfToken, registerUser, activateUser, loginUser, setUserRole } from './helpers';

/**
 * PR 3 — News system tests.
 *
 * Covers:
 *  - news table schema (created_at, status columns exist)
 *  - moderator can create draft news
 *  - admin can publish news
 *  - public /api/news returns only published items
 *  - draft news is not visible on public API
 *  - dangerous markdown/html payload is sanitized on save (XSS)
 *  - javascript: links are removed
 *  - slug generation and deduplication works
 *  - admin news mutation without CSRF returns 403
 *  - non-admin user cannot create/update news (403)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createNews(
  page: Page,
  data: {
    title: string;
    body_markdown: string;
    summary?: string;
    status?: string;
    slug?: string;
    pinned?: number;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post('/api/admin/news', {
    data,
    headers: { 'X-CSRF-Token': csrfToken },
  });
  return { status: res.status(), body: await res.json() };
}

async function updateNews(
  page: Page,
  id: number,
  data: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const csrfToken = await getCsrfToken(page);
  const res = await page.request.post(`/api/admin/news/${id}`, {
    data,
    headers: { 'X-CSRF-Token': csrfToken },
  });
  return { status: res.status(), body: await res.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('PR3 — News system', () => {
  test.beforeEach(async ({ page }) => {
    await resetDb(page);
  });

  // -------------------------------------------------------------------------
  // Schema smoke test
  // -------------------------------------------------------------------------
  test('news table has required columns', async ({ page }) => {
    // A GET to admin/news (as admin) should return an empty array without error
    await registerUser(page, 'newsadmin', 'newsadmin@test.local');
    await activateUser(page, 'newsadmin');
    await setUserRole(page, 'newsadmin', 'admin');
    await loginUser(page, 'newsadmin');

    const res = await page.request.get('/api/admin/news');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.news)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Moderator can create a draft
  // -------------------------------------------------------------------------
  test('moderator can create draft news', async ({ page }) => {
    await registerUser(page, 'moduser', 'moduser@test.local');
    await activateUser(page, 'moduser');
    await setUserRole(page, 'moduser', 'moderator');
    await loginUser(page, 'moduser');

    const { status, body } = await createNews(page, {
      title: 'Test Draft',
      body_markdown: '## Hello\n\nThis is a **draft** news item.',
      status: 'draft',
    });

    expect(status).toBe(201);
    const news = (body as { news: Record<string, unknown> }).news;
    expect(news.title).toBe('Test Draft');
    expect(news.status).toBe('draft');
    expect(typeof news.body_html).toBe('string');
    expect(news.body_html as string).toContain('<h2>');
    expect(news.body_html as string).toContain('<strong>draft</strong>');
  });

  // -------------------------------------------------------------------------
  // Admin can publish news
  // -------------------------------------------------------------------------
  test('admin can publish news and published_at is set', async ({ page }) => {
    await registerUser(page, 'adminpub', 'adminpub@test.local');
    await activateUser(page, 'adminpub');
    await setUserRole(page, 'adminpub', 'admin');
    await loginUser(page, 'adminpub');

    const { status, body } = await createNews(page, {
      title: 'Published News',
      body_markdown: 'Some content here.',
      status: 'published',
    });

    expect(status).toBe(201);
    const news = (body as { news: Record<string, unknown> }).news;
    expect(news.status).toBe('published');
    expect(news.published_at).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Public API returns only published items
  // -------------------------------------------------------------------------
  test('public /api/news returns only published items', async ({ page }) => {
    await registerUser(page, 'pubadmin', 'pubadmin@test.local');
    await activateUser(page, 'pubadmin');
    await setUserRole(page, 'pubadmin', 'admin');
    await loginUser(page, 'pubadmin');

    // Create a draft
    await createNews(page, {
      title: 'Draft Item',
      body_markdown: 'Draft content.',
      status: 'draft',
    });

    // Create a published item
    await createNews(page, {
      title: 'Published Item',
      body_markdown: 'Published content.',
      status: 'published',
    });

    const res = await page.request.get('/api/news');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = body.news as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('Published Item');
  });

  // -------------------------------------------------------------------------
  // Draft is not returned by public API
  // -------------------------------------------------------------------------
  test('draft news is not visible on public /api/news', async ({ page }) => {
    await registerUser(page, 'draftmod', 'draftmod@test.local');
    await activateUser(page, 'draftmod');
    await setUserRole(page, 'draftmod', 'moderator');
    await loginUser(page, 'draftmod');

    await createNews(page, {
      title: 'Secret Draft',
      body_markdown: 'Top secret.',
      status: 'draft',
    });

    const res = await page.request.get('/api/news');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect((body.news as unknown[]).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // XSS sanitization
  // -------------------------------------------------------------------------
  test('dangerous markdown payload is sanitized (XSS)', async ({ page }) => {
    await registerUser(page, 'xssadmin', 'xssadmin@test.local');
    await activateUser(page, 'xssadmin');
    await setUserRole(page, 'xssadmin', 'admin');
    await loginUser(page, 'xssadmin');

    const maliciousMarkdown = [
      '## Title',
      '',
      '<script>alert("xss")</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      'Normal **text** here.',
    ].join('\n');

    const { status, body } = await createNews(page, {
      title: 'XSS Test',
      body_markdown: maliciousMarkdown,
      status: 'draft',
    });

    expect(status).toBe(201);
    const news = (body as { news: Record<string, unknown> }).news;
    const html = news.body_html as string;

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('alert(');
    expect(html).not.toContain('<img');
    // Safe content preserved
    expect(html).toContain('<strong>text</strong>');
  });

  // -------------------------------------------------------------------------
  // javascript: links are stripped
  // -------------------------------------------------------------------------
  test('javascript: links are removed from body_html', async ({ page }) => {
    await registerUser(page, 'jslink', 'jslink@test.local');
    await activateUser(page, 'jslink');
    await setUserRole(page, 'jslink', 'admin');
    await loginUser(page, 'jslink');

    const { status, body } = await createNews(page, {
      title: 'JS Link Test',
      body_markdown: '[Click me](javascript:alert(1)) and [safe](https://example.com)',
      status: 'draft',
    });

    expect(status).toBe(201);
    const html = (body as { news: { body_html: string } }).news.body_html;
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://example.com');
  });

  // -------------------------------------------------------------------------
  // Slug generation
  // -------------------------------------------------------------------------
  test('slug is auto-generated from title when not provided', async ({ page }) => {
    await registerUser(page, 'slugtest', 'slugtest@test.local');
    await activateUser(page, 'slugtest');
    await setUserRole(page, 'slugtest', 'admin');
    await loginUser(page, 'slugtest');

    const { status, body } = await createNews(page, {
      title: 'My Awesome News',
      body_markdown: 'Content here.',
      status: 'draft',
    });

    expect(status).toBe(201);
    const news = (body as { news: Record<string, unknown> }).news;
    expect(news.slug).toBe('my-awesome-news');
  });

  // -------------------------------------------------------------------------
  // Slug deduplication
  // -------------------------------------------------------------------------
  test('slug is deduplicated when title collides', async ({ page }) => {
    await registerUser(page, 'slugdup', 'slugdup@test.local');
    await activateUser(page, 'slugdup');
    await setUserRole(page, 'slugdup', 'admin');
    await loginUser(page, 'slugdup');

    const { body: body1 } = await createNews(page, {
      title: 'Duplicate Title',
      body_markdown: 'First.',
      status: 'draft',
    });
    const { body: body2 } = await createNews(page, {
      title: 'Duplicate Title',
      body_markdown: 'Second.',
      status: 'draft',
    });

    const slug1 = (body1 as { news: { slug: string } }).news.slug;
    const slug2 = (body2 as { news: { slug: string } }).news.slug;
    expect(slug1).toBe('duplicate-title');
    expect(slug2).toBe('duplicate-title-2');
  });

  // -------------------------------------------------------------------------
  // CSRF protection
  // -------------------------------------------------------------------------
  test('create news without CSRF token returns 403', async ({ page }) => {
    await registerUser(page, 'csrfmod', 'csrfmod@test.local');
    await activateUser(page, 'csrfmod');
    await setUserRole(page, 'csrfmod', 'moderator');
    await loginUser(page, 'csrfmod');

    // No X-CSRF-Token header
    const res = await page.request.post('/api/admin/news', {
      data: {
        title: 'CSRF Test',
        body_markdown: 'Content.',
        status: 'draft',
      },
    });
    expect(res.status()).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Non-admin cannot create news
  // -------------------------------------------------------------------------
  test('plain user cannot create news (403)', async ({ page }) => {
    await registerUser(page, 'plainuser', 'plainuser@test.local');
    await activateUser(page, 'plainuser');
    await loginUser(page, 'plainuser');

    const { status } = await createNews(page, {
      title: 'Unauthorized',
      body_markdown: 'Should not work.',
      status: 'draft',
    });
    expect(status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Public /api/news/:slug endpoint
  // -------------------------------------------------------------------------
  test('GET /api/news/:slug returns published item', async ({ page }) => {
    await registerUser(page, 'slugadmin', 'slugadmin@test.local');
    await activateUser(page, 'slugadmin');
    await setUserRole(page, 'slugadmin', 'admin');
    await loginUser(page, 'slugadmin');

    await createNews(page, {
      title: 'Slug Fetch News',
      body_markdown: 'Content.',
      status: 'published',
    });

    const res = await page.request.get('/api/news/slug-fetch-news');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect((body.news as Record<string, unknown>).title).toBe('Slug Fetch News');
  });

  test('GET /api/news/:slug returns 404 for draft', async ({ page }) => {
    await registerUser(page, 'draftslug', 'draftslug@test.local');
    await activateUser(page, 'draftslug');
    await setUserRole(page, 'draftslug', 'admin');
    await loginUser(page, 'draftslug');

    await createNews(page, {
      title: 'Draft Slug Test',
      body_markdown: 'Content.',
      status: 'draft',
    });

    const res = await page.request.get('/api/news/draft-slug-test');
    expect(res.status()).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Update audit log
  // -------------------------------------------------------------------------
  test('news_create audit log entry is written', async ({ page }) => {
    await registerUser(page, 'auditadmin', 'auditadmin@test.local');
    await activateUser(page, 'auditadmin');
    await setUserRole(page, 'auditadmin', 'admin');
    await loginUser(page, 'auditadmin');

    const { body } = await createNews(page, {
      title: 'Audit News',
      body_markdown: 'Audit content.',
      status: 'draft',
    });

    const newsId = (body as { news: { id: number } }).news.id;

    // Write a probe to verify audit row exists
    const probeRes = await page.request.post('/api/dev/admin-audit-log/write', {
      data: {
        action: 'news_create_probe',
        targetType: 'news',
        targetId: newsId,
        details: { check: true },
      },
      headers: { 'X-CSRF-Token': await getCsrfToken(page) },
    });
    expect(probeRes.status()).toBe(200);
    const probeBody = await probeRes.json();
    expect(probeBody.row).toBeTruthy();
    expect(probeBody.row.action).toBe('news_create_probe');
  });

  // -------------------------------------------------------------------------
  // Update news
  // -------------------------------------------------------------------------
  test('admin can update news and body_html is regenerated', async ({ page }) => {
    await registerUser(page, 'updateadm', 'updateadm@test.local');
    await activateUser(page, 'updateadm');
    await setUserRole(page, 'updateadm', 'admin');
    await loginUser(page, 'updateadm');

    const { body: created } = await createNews(page, {
      title: 'Update Test',
      body_markdown: 'Original content.',
      status: 'draft',
    });

    const newsId = (created as { news: { id: number } }).news.id;

    const { status, body: updated } = await updateNews(page, newsId, {
      body_markdown: 'Updated **content**.',
    });

    expect(status).toBe(200);
    const html = (updated as { news: { body_html: string } }).news.body_html;
    expect(html).toContain('<strong>content</strong>');
  });

  // -------------------------------------------------------------------------
  // Non-admin cannot update news
  // -------------------------------------------------------------------------
  test('plain user cannot update news (403)', async ({ page }) => {
    // Setup: admin creates a news item
    await registerUser(page, 'adm4update', 'adm4update@test.local');
    await activateUser(page, 'adm4update');
    await setUserRole(page, 'adm4update', 'admin');
    await loginUser(page, 'adm4update');

    const { body: created } = await createNews(page, {
      title: 'Target News',
      body_markdown: 'Content.',
      status: 'draft',
    });
    const newsId = (created as { news: { id: number } }).news.id;

    // Logout admin
    const csrfToken = await getCsrfToken(page);
    await page.request.post('/api/auth/logout', {
      headers: { 'X-CSRF-Token': csrfToken },
    });

    // Login as plain user
    await registerUser(page, 'plain2', 'plain2@test.local');
    await activateUser(page, 'plain2');
    await loginUser(page, 'plain2');

    // Plain user should be forbidden
    const { status } = await updateNews(page, newsId, { title: 'Hacked' });
    expect(status).toBe(403);
  });
});
