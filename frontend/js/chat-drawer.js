/**
 * ChatDrawer — chat drawer module extracted from control.js.
 *
 * Usage:
 *   window.ChatDrawer.init(socket, sessionData);
 */
(function (window) {
    'use strict';

    function init(socket, sessionData) {
        var toggleBtn = document.getElementById('chat-toggle-btn');
        var drawer = document.getElementById('chat-drawer');
        var closeBtn = document.getElementById('chat-drawer-close');
        var chatMessagesEl = document.getElementById('chat-messages');
        var chatEmptyEl = document.getElementById('chat-empty');
        var chatInputEl = document.getElementById('chat-input');
        var chatSendBtnEl = document.getElementById('chat-send-btn');
        var chatJumpBtnEl = document.getElementById('chat-jump-btn');

        var _controlChatUser = null;
        var _chatInputPlaceholder = chatInputEl.placeholder;
        fetch('/api/auth/me').then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (data) {
            if (data && data.user) _controlChatUser = data.user;
        }).catch(function () {});

        function openDrawer() {
            document.body.setAttribute('data-chat-open', 'true');
            drawer.setAttribute('aria-hidden', 'false');
            scrollToBottom();
            chatInputEl.focus();
        }

        function closeDrawer() {
            document.body.setAttribute('data-chat-open', 'false');
            drawer.setAttribute('aria-hidden', 'true');
        }

        toggleBtn.addEventListener('click', function () {
            var isOpen = document.body.getAttribute('data-chat-open') === 'true';
            if (isOpen) closeDrawer(); else openDrawer();
        });

        closeBtn.addEventListener('click', closeDrawer);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && document.body.getAttribute('data-chat-open') === 'true') {
                closeDrawer();
            }
        });

        function isScrolledToBottom() {
            return chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < 60;
        }

        function scrollToBottom() {
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
        }

        function appendMessage(msg) {
            var wasAtBottom = isScrolledToBottom();
            chatEmptyEl.style.display = 'none';

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

                if (_controlChatUser && (_controlChatUser.role === 'admin' || _controlChatUser.role === 'moderator')) {
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
            chatMessagesEl.appendChild(div);

            if (wasAtBottom) {
                scrollToBottom();
                chatJumpBtnEl.classList.remove('visible');
            } else {
                chatJumpBtnEl.classList.add('visible');
            }
        }

        function markDeleted(id) {
            var el = chatMessagesEl.querySelector('[data-msg-id="' + id + '"]');
            if (!el) return;
            el.innerHTML = '';
            el.classList.add('chat-msg-deleted');
            var span = document.createElement('span');
            span.className = 'chat-msg-text chat-msg-deleted-text';
            span.textContent = 'Сообщение удалено';
            el.appendChild(span);
        }

        chatMessagesEl.addEventListener('scroll', function () {
            if (isScrolledToBottom()) chatJumpBtnEl.classList.remove('visible');
        });

        chatJumpBtnEl.addEventListener('click', function () {
            scrollToBottom();
            chatJumpBtnEl.classList.remove('visible');
        });

        function sendChatMessage() {
            var text = chatInputEl.value.trim();
            if (!text) return;
            socket.emit('chat:send', {
                message: text,
                userId: sessionData.dbUserId || null,
                username: sessionData.userId || null,
            });
            chatInputEl.value = '';
        }

        chatSendBtnEl.addEventListener('click', sendChatMessage);
        chatInputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') sendChatMessage();
        });

        socket.on('chat:history', function (data) {
            var msgs = chatMessagesEl.querySelectorAll('.chat-msg');
            msgs.forEach(function (el) { el.remove(); });
            var history = Array.isArray(data) ? data : (data && data.messages ? data.messages : []);
            if (!history || history.length === 0) {
                chatEmptyEl.style.display = '';
                return;
            }
            chatEmptyEl.style.display = 'none';
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
                chatInputEl.disabled = true;
                chatSendBtnEl.disabled = true;
                chatInputEl.placeholder = 'Подождите…';
                setTimeout(function () {
                    chatInputEl.disabled = false;
                    chatSendBtnEl.disabled = false;
                    chatInputEl.placeholder = _chatInputPlaceholder;
                }, 1500);
            }
        });
    }

    window.ChatDrawer = { init: init };
}(window));
