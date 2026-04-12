module.exports = {
  apps: [{
    name: 'riley-backend',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,                    // Single instance — SQLite doesn't support concurrent writers
    exec_mode: 'fork',              // Fork mode (not cluster — Socket.IO sticky sessions not needed with 1 instance)
    watch: false,                    // No file watching in production
    max_memory_restart: '256M',     // Restart if memory exceeds 256MB (Pi has limited RAM)
    kill_timeout: 8000,             // Give graceful shutdown 8s (server uses 5s force timeout internally)
    listen_timeout: 10000,          // Wait 10s for app to be ready
    shutdown_with_message: true,    // Send 'shutdown' message before SIGINT
    env: {
      NODE_ENV: 'production',
    },
    env_development: {
      NODE_ENV: 'development',
    },
    // Restart policy
    autorestart: true,
    max_restarts: 10,               // Max 10 restarts within restart_delay window
    restart_delay: 2000,            // Wait 2s between restarts
    exp_backoff_restart_delay: 1000, // Exponential backoff starting at 1s
    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Graceful shutdown
    wait_ready: true,               // Wait for process.send('ready') signal
  }],
};
