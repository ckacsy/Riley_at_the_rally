-- PR 3: news table and indexes
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  summary TEXT,
  body_markdown TEXT NOT NULL,
  body_html TEXT NOT NULL,
  cover_image TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  pinned INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER NOT NULL,
  published_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_slug ON news(slug);
CREATE INDEX IF NOT EXISTS idx_news_status ON news(status);
CREATE INDEX IF NOT EXISTS idx_news_published_at ON news(published_at);
CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(pinned);
