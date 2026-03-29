'use strict';

/**
 * Admin News page logic.
 * Depends on: AdminApi (admin-api.js), AdminUi (admin-ui.js), marked (vendor), DOMPurify (vendor)
 */
(function () {

    var flashEl       = document.getElementById('flash-container');
    var loadingEl     = document.getElementById('admin-loading');
    var contentEl     = document.getElementById('admin-content');
    var newsListEl    = document.getElementById('news-list');
    var listStateEl   = document.getElementById('news-list-state');

    var editorForm    = document.getElementById('editor-form');
    var editorPlaceholder = document.getElementById('editor-placeholder');
    var editorTitleEl = document.getElementById('editor-title');
    var editorFlashEl = document.getElementById('editor-flash');

    var fieldTitle    = document.getElementById('field-title');
    var fieldSlug     = document.getElementById('field-slug');
    var fieldStatus   = document.getElementById('field-status');
    var fieldSummary  = document.getElementById('field-summary');
    var fieldCover    = document.getElementById('field-cover');
    var fieldPinned   = document.getElementById('field-pinned');
    var fieldBody     = document.getElementById('field-body');

    var previewPane   = document.getElementById('preview-pane');
    var btnTogglePreview = document.getElementById('btn-toggle-preview');

    var btnSave       = document.getElementById('btn-save');
    var btnCancelEdit = document.getElementById('btn-cancel-edit');
    var btnNewNews    = document.getElementById('btn-new-news');

    var _editingId    = null; // null = creating new
    var _isDirty      = false;
    var _allNews      = [];
    var _selectedItem = null;

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------
    AdminApi.requireAdmin()
        .then(function () {
            loadingEl.hidden = true;
            contentEl.hidden = false;
            loadNews();
        })
        .catch(function () { /* requireAdmin handles redirects */ });

    // -------------------------------------------------------------------------
    // Load news list
    // -------------------------------------------------------------------------
    function loadNews() {
        showListState('Загрузка…');
        newsListEl.innerHTML = '';

        AdminApi.adminFetch('/api/admin/news')
            .then(function (data) {
                _allNews = data.news || [];
                renderNewsList();
            })
            .catch(function (err) {
                showListState('Ошибка: ' + err.message);
                AdminUi.showFlash(flashEl, err.message, 'error', 0);
            });
    }

    function renderNewsList() {
        newsListEl.innerHTML = '';
        hideListState();

        if (_allNews.length === 0) {
            showListState('Новостей нет. Создайте первую!');
            return;
        }

        _allNews.forEach(function (item) {
            newsListEl.appendChild(buildNewsItem(item));
        });
    }

    function buildNewsItem(item) {
        var el = document.createElement('div');
        el.className = 'news-item';
        el.dataset.newsId = String(item.id);
        if (_selectedItem && _selectedItem.id === item.id) {
            el.classList.add('selected');
        }

        var titleEl = document.createElement('div');
        titleEl.className = 'news-item-title';
        titleEl.textContent = item.title || '(без заголовка)';

        var metaEl = document.createElement('div');
        metaEl.className = 'news-item-meta';

        var statusBadge = document.createElement('span');
        statusBadge.className = 'badge badge-status--' + (item.status || 'draft');
        statusBadge.textContent = statusLabel(item.status);
        metaEl.appendChild(statusBadge);

        if (item.pinned) {
            var pinnedBadge = document.createElement('span');
            pinnedBadge.className = 'badge';
            pinnedBadge.style.background = 'rgba(255,193,7,0.2)';
            pinnedBadge.style.color = '#ffe082';
            pinnedBadge.textContent = '📌 Закреп';
            metaEl.appendChild(pinnedBadge);
        }

        var dateSpan = document.createElement('span');
        dateSpan.textContent = AdminUi.formatDate(item.updated_at || item.published_at);
        metaEl.appendChild(dateSpan);

        el.appendChild(titleEl);
        el.appendChild(metaEl);

        el.addEventListener('click', function () {
            openEditor(item);
        });

        return el;
    }

    function statusLabel(status) {
        var map = { draft: 'Черновик', published: 'Опубликовано', archived: 'Архив' };
        return map[status] || status || '—';
    }

    // -------------------------------------------------------------------------
    // Editor
    // -------------------------------------------------------------------------
    function openEditor(newsItem) {
        if (_isDirty && !window.confirm('У вас есть несохранённые изменения. Продолжить?')) return;

        _selectedItem = newsItem;
        _editingId = newsItem ? newsItem.id : null;
        _isDirty = false;

        // Highlight selected in list
        var items = newsListEl.querySelectorAll('.news-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('selected', items[i].dataset.newsId === String(newsItem.id));
        }

        editorTitleEl.textContent = newsItem ? 'Редактировать: ' + (newsItem.title || '') : 'Новая новость';
        editorPlaceholder.hidden = true;
        editorForm.hidden = false;

        fieldTitle.value   = newsItem.title || '';
        fieldSlug.value    = newsItem.slug || '';
        fieldStatus.value  = newsItem.status || 'draft';
        fieldSummary.value = newsItem.summary || '';
        fieldCover.value   = newsItem.cover_image || '';
        fieldPinned.checked = !!newsItem.pinned;
        fieldBody.value    = newsItem.body_markdown || '';

        AdminUi.clearFlash(editorFlashEl);
        hidePreview();
    }

    function openNewEditor() {
        if (_isDirty && !window.confirm('У вас есть несохранённые изменения. Продолжить?')) return;

        _selectedItem = null;
        _editingId = null;
        _isDirty = false;

        // Deselect all
        var items = newsListEl.querySelectorAll('.news-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('selected');
        }

        editorTitleEl.textContent = 'Новая новость';
        editorPlaceholder.hidden = true;
        editorForm.hidden = false;

        fieldTitle.value   = '';
        fieldSlug.value    = '';
        fieldStatus.value  = 'draft';
        fieldSummary.value = '';
        fieldCover.value   = '';
        fieldPinned.checked = false;
        fieldBody.value    = '';

        AdminUi.clearFlash(editorFlashEl);
        hidePreview();
        fieldTitle.focus();
    }

    function cancelEditor() {
        if (_isDirty && !window.confirm('Отменить изменения?')) return;
        _isDirty = false;
        _selectedItem = null;
        _editingId = null;
        editorForm.hidden = true;
        editorPlaceholder.hidden = false;
        editorTitleEl.textContent = 'Редактор';
        var items = newsListEl.querySelectorAll('.news-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('selected');
        }
    }

    // -------------------------------------------------------------------------
    // Save
    // -------------------------------------------------------------------------
    editorForm.addEventListener('submit', function (e) {
        e.preventDefault();
        saveNews();
    });

    function saveNews() {
        var title = fieldTitle.value.trim();
        if (!title) {
            AdminUi.showFlash(editorFlashEl, 'Введите заголовок', 'error', 0);
            return;
        }
        var body = fieldBody.value.trim();
        if (!body) {
            AdminUi.showFlash(editorFlashEl, 'Введите текст новости', 'error', 0);
            return;
        }

        var payload = {
            title:         title,
            slug:          fieldSlug.value.trim() || undefined,
            status:        fieldStatus.value,
            summary:       fieldSummary.value.trim() || undefined,
            cover_image:   fieldCover.value.trim() || undefined,
            pinned:        fieldPinned.checked ? 1 : 0,
            body_markdown: body,
        };

        // Strip undefined keys
        Object.keys(payload).forEach(function (k) {
            if (payload[k] === undefined) delete payload[k];
        });

        btnSave.disabled = true;
        AdminUi.clearFlash(editorFlashEl);

        var url = _editingId
            ? '/api/admin/news/' + _editingId
            : '/api/admin/news';

        AdminApi.adminFetch(url, { method: 'POST', body: payload })
            .then(function (data) {
                _isDirty = false;
                btnSave.disabled = false;
                var savedItem = data.news;
                AdminUi.showFlash(flashEl, _editingId ? 'Новость обновлена' : 'Новость создана', 'success');

                // Update local data and refresh list
                if (_editingId) {
                    _allNews = _allNews.map(function (n) { return n.id === savedItem.id ? savedItem : n; });
                } else {
                    _allNews.unshift(savedItem);
                    _editingId = savedItem.id;
                    _selectedItem = savedItem;
                    editorTitleEl.textContent = 'Редактировать: ' + savedItem.title;
                }
                renderNewsList();
            })
            .catch(function (err) {
                AdminUi.showFlash(editorFlashEl, err.message, 'error', 0);
                btnSave.disabled = false;
            });
    }

    // -------------------------------------------------------------------------
    // Dirty tracking
    // -------------------------------------------------------------------------
    [fieldTitle, fieldSlug, fieldSummary, fieldCover, fieldBody].forEach(function (el) {
        el.addEventListener('input', function () { _isDirty = true; });
    });
    fieldStatus.addEventListener('change', function () { _isDirty = true; });
    fieldPinned.addEventListener('change', function () { _isDirty = true; });

    window.addEventListener('beforeunload', function (e) {
        if (_isDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // -------------------------------------------------------------------------
    // Markdown preview
    // -------------------------------------------------------------------------
    btnTogglePreview.addEventListener('click', function () {
        if (previewPane.hidden) {
            showPreview();
        } else {
            hidePreview();
        }
    });

    function showPreview() {
        var markdown = fieldBody.value;
        var rawHtml = (typeof marked !== 'undefined')
            ? marked.parse(markdown)
            : '<p>' + AdminUi.esc(markdown) + '</p>';

        var safeHtml = (typeof DOMPurify !== 'undefined')
            ? DOMPurify.sanitize(rawHtml, {
                ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li',
                               'blockquote', 'code', 'pre', 'h2', 'h3', 'a'],
                ALLOWED_ATTR: ['href', 'title', 'rel', 'target'],
            })
            : rawHtml;

        previewPane.innerHTML = safeHtml;
        previewPane.hidden = false;
        btnTogglePreview.textContent = '✕ Скрыть предпросмотр';
    }

    function hidePreview() {
        previewPane.hidden = true;
        previewPane.innerHTML = '';
        btnTogglePreview.textContent = '👁 Предпросмотр';
    }

    // -------------------------------------------------------------------------
    // Button event handlers
    // -------------------------------------------------------------------------
    btnNewNews.addEventListener('click', openNewEditor);
    btnCancelEdit.addEventListener('click', cancelEditor);

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function showListState(msg) {
        listStateEl.textContent = msg;
        listStateEl.hidden = false;
    }

    function hideListState() {
        listStateEl.hidden = true;
    }

})();
