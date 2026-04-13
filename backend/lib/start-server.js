'use strict';

const MAX_PORT_RETRIES = 10;

module.exports = function createStartServer(server, metrics, mailer, basePort) {
  function startServer(port, attempt) {
    attempt = attempt || 0;

    server.listen(port, () => {
      const finalPort = server.address().port;
      metrics.log('info', 'server_start', { port: finalPort, nodeEnv: process.env.NODE_ENV || 'development' });

      const appBaseUrl = process.env.APP_BASE_URL;
      if (appBaseUrl && finalPort !== basePort) {
        console.warn(`[server] Warning: APP_BASE_URL (${appBaseUrl}) still points at port ${basePort}, but server started on port ${finalPort}. Update your .env if needed.`);
      }

      mailer.verifyConnection();

      if (typeof process.send === 'function') {
        process.send('ready');
      }
    });

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (process.env.NODE_ENV === 'production') {
          console.error(`[server] Port ${port} is already in use. Exiting (production mode).`);
          process.exit(1);
        }
        if (attempt >= MAX_PORT_RETRIES) {
          console.error(`[server] Could not find a free port after ${MAX_PORT_RETRIES} attempts. Last tried: ${port}. Exiting.`);
          process.exit(1);
        }
        const nextPort = port + 1;
        console.warn(`[server] Port ${port} is already in use, retrying on port ${nextPort} (attempt ${attempt + 1}/${MAX_PORT_RETRIES})...`);
        startServer(nextPort, attempt + 1);
      } else {
        console.error('[server] Unexpected server error:', err.message);
        process.exit(1);
      }
    });
  }

  return startServer;
};
