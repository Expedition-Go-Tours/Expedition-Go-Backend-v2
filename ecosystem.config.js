module.exports = {
  apps: [{
    name: 'expedition-api',
    script: 'server.js',
    cwd: '/home/deploy/Expedition-Go-Backend-v2',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    max_memory_restart: '350M',
    // Keep the same log paths PM2 has used for this app so incident-monitor
    // tails (/home/deploy/.pm2/logs/expedition-api-error.log) keep working
    // after the cluster migration.
    error_file: '/home/deploy/.pm2/logs/expedition-api-error.log',
    out_file: '/home/deploy/.pm2/logs/expedition-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    watch: false,
    // Graceful reload: pm2 waits up to listen_timeout for the process to
    // signal ready (it listens immediately), and up to kill_timeout after
    // SIGINT for in-flight requests to drain before SIGKILL. Must exceed the
    // server.js drain grace (5s) so workers exit cleanly.
    listen_timeout: 10000,
    kill_timeout: 15000
  }]
};
