(function () {
  // ── Fullscreen toggle ──
  var viewport = document.getElementById('broadcast-viewport');
  var fullscreenBtn = document.getElementById('fullscreen-btn');
  var exitBtn = document.getElementById('exit-fullscreen-btn');

  function enterFullscreen() {
    viewport.classList.add('is-fullscreen');
    if (viewport.requestFullscreen) {
      viewport.requestFullscreen().catch(function (err) {
        console.error('requestFullscreen failed:', err);
      });
    }
  }

  function exitFullscreen() {
    viewport.classList.remove('is-fullscreen');
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function (err) {
        console.error('exitFullscreen failed:', err);
      });
    }
  }

  fullscreenBtn.addEventListener('click', enterFullscreen);
  exitBtn.addEventListener('click', exitFullscreen);

  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) {
      viewport.classList.remove('is-fullscreen');
    }
  });

  // ── Camera selector (MVP — switches active btn; pluggable src swap) ──
  (function initCameraSelector() {
    var camBtns = document.querySelectorAll('.cam-btn');
    camBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        camBtns.forEach(function (b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        // TODO: swap stream src when real camera URLs are available via API
        var cam = btn.getAttribute('data-cam');
        var placeholder = document.getElementById('stream-placeholder');
        if (placeholder) {
          var sub = placeholder.querySelector('.overlay-sub');
          if (sub) {
            if (cam === 'car') {
              sub.textContent = 'Камера из машинки (появится в активной сессии)';
            } else {
              var label = btn.getAttribute('data-label') || cam;
              sub.textContent = 'Статичная ' + label + ' — подключение скоро';
            }
          }
        }
      });
    });
  })();

  // ── Driver presence ──
  var driversList = document.getElementById('drivers-list');
  var driversEmpty = document.getElementById('drivers-empty');

  function renderDrivers(drivers) {
    var items = driversList.querySelectorAll('.driver-item');
    items.forEach(function (el) { el.remove(); });

    if (!drivers || drivers.length === 0) {
      driversEmpty.style.display = '';
      return;
    }

    driversEmpty.style.display = 'none';
    drivers.forEach(function (driver) {
      var li = document.createElement('li');
      li.className = 'driver-item';
      li.setAttribute('data-user-id', driver.userId);

      var dot = document.createElement('span');
      dot.className = 'driver-dot';

      var name = document.createElement('span');
      name.className = 'driver-name';
      name.textContent = driver.username;

      li.appendChild(dot);
      li.appendChild(name);
      driversList.appendChild(li);
    });
  }

  // ── Chat ──
  var chatMessages = document.getElementById('chat-messages');
  var chatEmpty = document.getElementById('chat-empty');
  var chatInput = document.getElementById('chat-input');
  var chatSendBtn = document.getElementById('chat-send-btn');
  var chatJumpBtn = document.getElementById('chat-jump-btn');

  function isScrolledToBottom() {
    return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 40;
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendMessage(msg) {
    var wasAtBottom = isScrolledToBottom();
    chatEmpty.style.display = 'none';

    var div = document.createElement('div');
    div.className = 'chat-msg';
    div.setAttribute('data-msg-id', msg.id);

    if (msg.deleted) {
      div.classList.add('chat-msg-deleted');
      var deletedSpan = document.createElement('span');
      deletedSpan.className = 'chat-msg-text chat-msg-deleted-text';
      deletedSpan.textContent = 'Сообщение удалено';
      div.appendChild(deletedSpan);
    } else {
      var userSpan = document.createElement('span');
      userSpan.className = 'chat-msg-user';
      userSpan.textContent = msg.username + ':';

      var textSpan = document.createElement('span');
      textSpan.className = 'chat-msg-text';
      textSpan.textContent = ' ' + msg.message;

      var timeSpan = document.createElement('span');
      timeSpan.className = 'chat-msg-time';
      if (msg.createdAt) {
        var d = new Date(msg.createdAt);
        if (!isNaN(d.getTime())) {
          timeSpan.textContent = ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        }
      }

      div.appendChild(userSpan);
      div.appendChild(textSpan);
      div.appendChild(timeSpan);

      if (window._chatUser && (window._chatUser.role === 'admin' || window._chatUser.role === 'moderator')) {
        var delBtn = document.createElement('button');
        delBtn.className = 'chat-msg-delete-btn';
        delBtn.textContent = '🗑️';
        delBtn.title = 'Удалить сообщение';
        (function (msgId) {
          delBtn.addEventListener('click', function () {
            socket.emit('chat:delete', { id: msgId });
          });
        }(msg.id));
        div.appendChild(delBtn);
      }
    }
    chatMessages.appendChild(div);

    if (wasAtBottom) {
      scrollToBottom();
      chatJumpBtn.classList.remove('visible');
    } else {
      chatJumpBtn.classList.add('visible');
    }
  }

  function markDeleted(id) {
    var el = chatMessages.querySelector('[data-msg-id="' + id + '"]');
    if (!el) return;
    el.innerHTML = '';
    el.classList.add('chat-msg-deleted');
    var span = document.createElement('span');
    span.className = 'chat-msg-text chat-msg-deleted-text';
    span.textContent = 'Сообщение удалено';
    el.appendChild(span);
  }

  chatMessages.addEventListener('scroll', function () {
    if (isScrolledToBottom()) {
      chatJumpBtn.classList.remove('visible');
    }
  });

  chatJumpBtn.addEventListener('click', function () {
    scrollToBottom();
    chatJumpBtn.classList.remove('visible');
  });

  function sendChatMessage() {
    var text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat:send', { message: text, userId: window._chatUser && window._chatUser.id, username: window._chatUser && window._chatUser.username });
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendChatMessage();
  });

  // Fetch current user info for auth in chat:send
  window._chatUser = null;
  var _chatUserReady = false;
  fetch('/api/auth/me').then(function (r) {
    return r.ok ? r.json() : null;
  }).then(function (data) {
    if (data && data.user) window._chatUser = data.user;
    _chatUserReady = true;
    // Mark page as fully ready when both socket and user info are available
    if (document.body.getAttribute('data-socket-connected') === 'true') {
      document.body.setAttribute('data-socket-ready', 'true');
    }
  }).catch(function () {
    _chatUserReady = true;
    if (document.body.getAttribute('data-socket-connected') === 'true') {
      document.body.setAttribute('data-socket-ready', 'true');
    }
  });

  // ── Socket ──
  var socket = io(window.location.origin);
  window.__testSocket = socket;

  socket.on('connect', function () {
    socket.emit('presence:hello', { page: 'broadcast' });
  });

  socket.on('presence:update', function (data) {
    renderDrivers(data && data.drivers ? data.drivers : []);
  });

  socket.on('chat:history', function (data) {
    // Clear existing messages
    var msgs = chatMessages.querySelectorAll('.chat-msg');
    msgs.forEach(function (el) { el.remove(); });
    // Mark socket as connected
    document.body.setAttribute('data-socket-connected', 'true');
    // Mark ready only if user info is also loaded
    if (_chatUserReady) {
      document.body.setAttribute('data-socket-ready', 'true');
    }
    var history = Array.isArray(data) ? data : (data && data.messages ? data.messages : []);
    if (!history || history.length === 0) {
      chatEmpty.style.display = '';
      return;
    }
    chatEmpty.style.display = 'none';
    history.forEach(function (msg) { appendMessage(msg); });
    scrollToBottom();
  });

  socket.on('chat:message', function (msg) {
    appendMessage(msg);
  });

  socket.on('chat:deleted', function (data) {
    if (data && data.id != null) markDeleted(data.id);
  });

  socket.on('chat:error', function (err) {
    if (err && err.code === 'rate_limited') {
      chatInput.disabled = true;
      chatSendBtn.disabled = true;
      setTimeout(function () {
        chatInput.disabled = false;
        chatSendBtn.disabled = false;
        chatInput.focus();
      }, 1500);
    }
  });

  // ── Video stream player ──
  (function initVideoPlayer() {
    var vp = document.getElementById('broadcast-viewport');
    var placeholder = document.getElementById('stream-placeholder');

    fetch('/api/config/video').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (cfg) {
      if (!cfg || !cfg.streamUrl) return; // No stream configured — keep placeholder

      // Hide placeholder
      placeholder.style.display = 'none';

      if (cfg.type === 'mjpeg') {
        var img = document.createElement('img');
        img.id = 'stream-img';
        img.src = cfg.streamUrl;
        img.alt = 'Трансляция';
        vp.insertBefore(img, vp.firstChild);
      } else {
        // HLS (or any other type defaults to HLS)
        var video = document.createElement('video');
        video.id = 'stream-video';
        video.autoplay = true;
        video.muted = true;
        video.controls = true;
        video.playsInline = true;

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS (Safari / iOS)
          video.src = cfg.streamUrl;
          vp.insertBefore(video, vp.firstChild);
        } else {
          // Load hls.js from CDN then initialise
          var script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
          script.onload = function () {
            if (window.Hls && window.Hls.isSupported()) {
              var hls = new window.Hls();
              hls.loadSource(cfg.streamUrl);
              hls.attachMedia(video);
            } else {
              // Fallback: try setting src directly
              video.src = cfg.streamUrl;
            }
            vp.insertBefore(video, vp.firstChild);
          };
          script.onerror = function () {
            // CDN unavailable — try native src as last resort
            video.src = cfg.streamUrl;
            vp.insertBefore(video, vp.firstChild);
          };
          document.head.appendChild(script);
        }
      }
    }).catch(function () {
      // Network error fetching config — keep placeholder
    });
  })();
})();
