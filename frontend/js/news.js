'use strict';

/**
 * Fetch published news from the API and render them into #news-panel.
 * All body_html is sanitized on the frontend with DOMPurify before insertion.
 */
(function initNewsPanel() {
  const panel = document.getElementById('news-panel');
  if (!panel) return;

  /**
   * Format an ISO date string to a locale-friendly short date.
   * @param {string|null} iso
   * @returns {string}
   */
  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    } catch (_) {
      return iso.slice(0, 10);
    }
  }

  /**
   * Safely sanitize HTML using DOMPurify (must be loaded before this script).
   * Falls back to text-only if DOMPurify is unavailable.
   * @param {string} html
   * @returns {string}
   */
  function safeHtml(html) {
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li',
                        'blockquote', 'code', 'pre', 'h2', 'h3', 'a'],
        ALLOWED_ATTR: ['href', 'title', 'rel', 'target'],
        FORCE_BODY: false,
      });
    }
    // Fallback: strip all tags
    const div = document.createElement('div');
    div.textContent = html;
    return div.innerHTML;
  }

  /**
   * Render a single news item card.
   * @param {{ id: number, title: string, slug: string, summary: string|null,
   *           body_html: string, cover_image: string|null, published_at: string|null }} item
   * @returns {HTMLElement}
   */
  function renderNewsCard(item) {
    const el = document.createElement('div');
    el.className = 'news-tab-item';
    el.dataset.newsId = String(item.id);

    const dateEl = document.createElement('span');
    dateEl.className = 'news-tab-date';
    dateEl.textContent = formatDate(item.published_at);

    const titleEl = document.createElement('span');
    titleEl.className = 'news-tab-title';
    titleEl.textContent = item.title;

    el.appendChild(dateEl);
    el.appendChild(titleEl);

    if (item.summary) {
      const previewEl = document.createElement('p');
      previewEl.className = 'news-tab-preview';
      previewEl.textContent = item.summary;
      el.appendChild(previewEl);
    }

    // Full body is hidden by default, toggled on click
    const bodyEl = document.createElement('div');
    bodyEl.className = 'news-tab-body';
    bodyEl.hidden = true;
    bodyEl.innerHTML = safeHtml(item.body_html);
    el.appendChild(bodyEl);

    el.addEventListener('click', () => {
      bodyEl.hidden = !bodyEl.hidden;
      el.classList.toggle('expanded', !bodyEl.hidden);
    });

    return el;
  }

  /**
   * Render the error/empty state inside the panel.
   * @param {string} message
   */
  function renderEmpty(message) {
    panel.innerHTML = '';
    const msg = document.createElement('span');
    msg.className = 'news-tab-empty';
    msg.textContent = message;
    panel.appendChild(msg);
  }

  /**
   * Load news from /api/news and render into the panel.
   */
  function loadNews() {
    fetch('/api/news', { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        const items = Array.isArray(data.news) ? data.news : [];
        panel.innerHTML = '';

        if (items.length === 0) {
          renderEmpty('Новостей пока нет');
          return;
        }

        items.forEach((item) => {
          panel.appendChild(renderNewsCard(item));
        });
      })
      .catch(() => {
        renderEmpty('Не удалось загрузить новости');
      });
  }

  loadNews();
})();
