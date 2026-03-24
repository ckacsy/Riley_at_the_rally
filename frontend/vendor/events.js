/**
 * Shared Socket.io event name constants for Riley at the Rally.
 *
 * UMD wrapper — works in both Node.js (require) and browser (<script> tag).
 * Browser: access via global `RILEY_EVENTS`
 * Node.js: const EVENTS = require('../frontend/vendor/events.js')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RILEY_EVENTS = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return Object.freeze({
    // Chat events
    CHAT_SEND:       'chat:send',
    CHAT_MESSAGE:    'chat:message',
    CHAT_HISTORY:    'chat:history',

    // Presence events
    PRESENCE_UPDATE: 'presence:update',

    // Driver lifecycle
    DRIVER_MARK:     'driver:mark',

    // Broadcast room join (for spectators on /broadcast page)
    BROADCAST_JOIN:  'broadcast:join',
  });
}));
