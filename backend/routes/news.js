'use strict';

const { createRateLimiter } = require('../middleware/rateLimiter');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

// ---------------------------------------------------------------------------
// Sanitization options — only safe tags, no inline images
// ---------------------------------------------------------------------------
const SANITIZE_OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'h2', 'h3', 'a'],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {},
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
  },
};

/**
 * Render markdown to sanitized HTML.
 * @param {string} markdown
 * @returns {string} sanitized HTML
 */
function renderMarkdown(markdown) {
  const rawHtml = marked.parse(markdown, { mangle: false, headerIds: false });
  return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------
/**
 * Convert a title to a URL-safe lowercase slug.
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .normalize('NFC')
    // Replace Cyrillic characters (already lowercased) with transliteration
    .replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] || ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Simple Cyrillic transliteration map for slug generation
const CYRILLIC_MAP = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z',
  и:'i', й:'j', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r',
  с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh',
  щ:'shch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
};

/**
 * Generate a unique slug based on title.  Appends -2, -3, ... if slug exists.
 * @param {import('better-sqlite3').Database} db
 * @param {string} title
 * @param {number|null} excludeId - ignore this news id when checking collision (for update)
 */
function uniqueSlug(db, title, excludeId) {
  const base = slugify(title) || 'news';
  const stmtCheck = db.prepare(
    excludeId != null
      ? 'SELECT id FROM news WHERE slug = ? AND id != ?'
      : 'SELECT id FROM news WHERE slug = ?'
  );

  const exists = (candidate) =>
    excludeId != null
      ? stmtCheck.get(candidate, excludeId)
      : stmtCheck.get(candidate);

  if (!exists(base)) return base;

  let i = 2;
  while (exists(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const VALID_STATUSES = new Set(['draft', 'published', 'archived']);

// Whitelist of column names that may appear in a dynamic UPDATE SET clause.
// Prevents future accidental injection of attacker-controlled column names.
const ALLOWED_UPDATE_COLUMNS = new Set([
  'title', 'slug', 'summary', 'cover_image', 'body_markdown', 'body_html',
  'status', 'pinned', 'author_id', 'published_at', 'updated_at',
]);

function validateNewsBody(body) {
  const errors = [];
  const { title, body_markdown, status, pinned, slug, summary, cover_image } = body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    errors.push('title is required');
  } else if (title.trim().length > 200) {
    errors.push('title must be at most 200 characters');
  }
  if (!body_markdown || typeof body_markdown !== 'string' || !body_markdown.trim()) {
    errors.push('body_markdown is required');
  } else if (body_markdown.trim().length > 50000) {
    errors.push('body_markdown must be at most 50000 characters');
  }
  if (summary !== undefined && summary !== null && typeof summary === 'string' && summary.trim().length > 500) {
    errors.push('summary must be at most 500 characters');
  }
  if (cover_image !== undefined && cover_image !== null && typeof cover_image === 'string' && cover_image.trim().length > 500) {
    errors.push('cover_image must be at most 500 characters');
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    errors.push('status must be draft, published, or archived');
  }
  if (slug !== undefined && slug !== null && slug !== '') {
    const cleaned = String(slug).trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) {
      errors.push('slug must be lowercase alphanumeric with hyphens');
    }
  }
  if (pinned !== undefined) {
    const p = Number(pinned);
    if (p !== 0 && p !== 1 && pinned !== true && pinned !== false) {
      errors.push('pinned must be 0 or 1');
    }
  }
  return errors;
}

/**
 * Validate only the fields actually present in an update body.
 * @param {Record<string, unknown>} body
 * @returns {string[]} array of error messages
 */
function validateNewsUpdate(body) {
  const errors = [];
  const { title, body_markdown, status, pinned, slug, summary, cover_image } = body;

  if (title !== undefined) {
    if (!title || typeof title !== 'string' || !title.trim()) {
      errors.push('title is required');
    } else if (title.trim().length > 200) {
      errors.push('title must be at most 200 characters');
    }
  }
  if (body_markdown !== undefined) {
    if (!body_markdown || typeof body_markdown !== 'string' || !body_markdown.trim()) {
      errors.push('body_markdown is required');
    } else if (body_markdown.trim().length > 50000) {
      errors.push('body_markdown must be at most 50000 characters');
    }
  }
  if (summary !== undefined && summary !== null && typeof summary === 'string' && summary.trim().length > 500) {
    errors.push('summary must be at most 500 characters');
  }
  if (cover_image !== undefined && cover_image !== null && typeof cover_image === 'string' && cover_image.trim().length > 500) {
    errors.push('cover_image must be at most 500 characters');
  }
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    errors.push('status must be draft, published, or archived');
  }
  if (slug !== undefined && slug !== null && slug !== '') {
    const cleaned = String(slug).trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) {
      errors.push('slug must be lowercase alphanumeric with hyphens');
    }
  }
  if (pinned !== undefined) {
    const p = Number(pinned);
    if (p !== 0 && p !== 1 && pinned !== true && pinned !== false) {
      errors.push('pinned must be 0 or 1');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------
/**
 * Mount news routes (admin + public).
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   requireRole: (...roles: string[]) => Function,
 *   csrfMiddleware: Function,
 *   logAdminAudit: (data: object) => void,
 * }} deps
 */
module.exports = function mountNewsRoutes(app, db, deps) {
  const { requireRole, csrfMiddleware, logAdminAudit } = deps;

  const newsReadLimiter = createRateLimiter({ max: 120 });

  const newsWriteLimiter = createRateLimiter({ max: 30 });

  // -------------------------------------------------------------------------
  // GET /api/admin/news
  // -------------------------------------------------------------------------
  app.get(
    '/api/admin/news',
    newsReadLimiter,
    requireRole('moderator', 'admin'),
    (req, res) => {
      const rows = db
        .prepare(
          `SELECT id, title, slug, summary, status, pinned, author_id,
                  published_at, created_at, updated_at
             FROM news
            ORDER BY created_at DESC
            LIMIT 200`
        )
        .all();
      res.json({ news: rows });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/news  (create)
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/news',
    newsWriteLimiter,
    requireRole('moderator', 'admin'),
    csrfMiddleware,
    (req, res) => {
      const body = req.body || {};
      const errors = validateNewsBody(body);
      if (errors.length) {
        return res.status(400).json({ error: 'validation_error', messages: errors });
      }

      const title = body.title.trim();
      const bodyMarkdown = body.body_markdown.trim();
      const summary = body.summary ? String(body.summary).trim() : null;
      const coverImage = body.cover_image ? String(body.cover_image).trim() : null;
      const status = (body.status && VALID_STATUSES.has(body.status)) ? body.status : 'draft';
      const pinned = (body.pinned === true || Number(body.pinned) === 1) ? 1 : 0;
      const authorId = req.user.id;

      // Slug — use provided slug or generate from title
      let slug;
      if (body.slug && String(body.slug).trim()) {
        const requestedSlug = String(body.slug).trim().toLowerCase();
        const existing = db.prepare('SELECT id FROM news WHERE slug = ?').get(requestedSlug);
        if (existing) {
          return res.status(409).json({ error: 'slug_conflict', message: 'Slug already in use' });
        }
        slug = requestedSlug;
      } else {
        slug = uniqueSlug(db, title, null);
      }

      // Render and sanitize markdown
      let bodyHtml;
      try {
        bodyHtml = renderMarkdown(bodyMarkdown);
      } catch (e) {
        return res.status(400).json({ error: 'Ошибка обработки markdown.' });
      }

      // If publishing now and no published_at set it
      const publishedAt = (status === 'published') ? new Date().toISOString() : null;

      const result = db.prepare(
        `INSERT INTO news (title, slug, summary, body_markdown, body_html, cover_image,
                           status, pinned, author_id, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(title, slug, summary, bodyMarkdown, bodyHtml, coverImage, status, pinned, authorId, publishedAt);

      const created = db.prepare('SELECT * FROM news WHERE id = ?').get(result.lastInsertRowid);

      logAdminAudit({
        adminId: authorId,
        action: 'news_create',
        targetType: 'news',
        targetId: created.id,
        details: { title, slug, status },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });

      res.status(201).json({ success: true, news: created });
    }
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/news/:id  (update)
  // -------------------------------------------------------------------------
  app.post(
    '/api/admin/news/:id',
    newsWriteLimiter,
    requireRole('moderator', 'admin'),
    csrfMiddleware,
    (req, res) => {
      const newsId = parseInt(req.params.id, 10);
      if (!Number.isInteger(newsId)) {
        return res.status(400).json({ error: 'Invalid news id' });
      }

      const existing = db.prepare('SELECT * FROM news WHERE id = ?').get(newsId);
      if (!existing) return res.status(404).json({ error: 'News item not found' });

      const body = req.body || {};

      const errors = validateNewsUpdate(body);
      if (errors.length) {
        return res.status(400).json({ error: 'validation_error', messages: errors });
      }

      // Build update fields
      const updates = {};
      if (body.title !== undefined) updates.title = String(body.title).trim();
      if (body.summary !== undefined) updates.summary = body.summary ? String(body.summary).trim() : null;
      if (body.cover_image !== undefined) updates.cover_image = body.cover_image ? String(body.cover_image).trim() : null;
      if (body.status !== undefined) updates.status = body.status;
      if (body.pinned !== undefined) updates.pinned = (body.pinned === true || Number(body.pinned) === 1) ? 1 : 0;

      // Handle slug change
      if (body.slug !== undefined && String(body.slug).trim() !== '') {
        const newSlug = String(body.slug).trim().toLowerCase();
        if (newSlug !== existing.slug) {
          const collision = db.prepare('SELECT id FROM news WHERE slug = ? AND id != ?').get(newSlug, newsId);
          if (collision) {
            return res.status(409).json({ error: 'slug_conflict', message: 'Slug already in use' });
          }
          updates.slug = newSlug;
        }
      } else if (body.title !== undefined && updates.title !== existing.title) {
        // Regenerate slug only when no explicit slug given but title changed
        updates.slug = uniqueSlug(db, updates.title, newsId);
      }

      // Regenerate HTML if markdown changed
      if (body.body_markdown !== undefined) {
        const newMarkdown = String(body.body_markdown).trim();
        updates.body_markdown = newMarkdown;
        try {
          updates.body_html = renderMarkdown(newMarkdown);
        } catch (e) {
          return res.status(400).json({ error: 'Ошибка обработки markdown.' });
        }
      }

      // Auto-set published_at when transitioning to published
      if (updates.status === 'published' && !existing.published_at) {
        updates.published_at = new Date().toISOString();
      }

      updates.updated_at = new Date().toISOString();

      const safeKeys = Object.keys(updates).filter((k) => ALLOWED_UPDATE_COLUMNS.has(k));
      const setClauses = safeKeys.map((k) => `${k} = ?`).join(', ');
      const values = [...safeKeys.map((k) => updates[k]), newsId];

      db.prepare(`UPDATE news SET ${setClauses} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT * FROM news WHERE id = ?').get(newsId);

      logAdminAudit({
        adminId: req.user.id,
        action: 'news_update',
        targetType: 'news',
        targetId: newsId,
        details: { changes: Object.keys(updates).filter((k) => k !== 'updated_at') },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });

      res.json({ success: true, news: updated });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/news  (public — published only)
  // -------------------------------------------------------------------------
  app.get(
    '/api/news',
    newsReadLimiter,
    (req, res) => {
      const rows = db
        .prepare(
          `SELECT id, title, slug, summary, body_html, cover_image, published_at
             FROM news
            WHERE status = 'published'
            ORDER BY pinned DESC, published_at DESC, id DESC`
        )
        .all();
      res.json({ news: rows });
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/news/:slug  (public — single published item)
  // -------------------------------------------------------------------------
  app.get(
    '/api/news/:slug',
    newsReadLimiter,
    (req, res) => {
      const slug = req.params.slug;
      if (!slug || typeof slug !== 'string') {
        return res.status(400).json({ error: 'Invalid slug' });
      }
      const row = db
        .prepare(
          `SELECT id, title, slug, summary, body_html, cover_image, published_at
             FROM news
            WHERE slug = ? AND status = 'published'`
        )
        .get(slug);

      if (!row) return res.status(404).json({ error: 'News item not found' });
      res.json({ news: row });
    }
  );
};
