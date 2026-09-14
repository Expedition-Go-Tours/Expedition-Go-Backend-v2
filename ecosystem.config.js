module.exports = {
  apps: [{
    name: 'expedition-api',
    script: 'server.js',
    cwd: '/home/deploy/Expedition-Go-Backend-v2',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    max_memory_restart: '500M',
    node_args: '--max-old-space-size=400',
    // Crash-loop guard: without this, a bind failure (e.g. EADDRINUSE when a
    // stray PM2 daemon or leftover process holds the port) restarts the app
    // every ~1s, pinning CPU and load. Exponential backoff spaces retries
    // out to ~15s so a transient conflict self-heals instead of hammering.
    exp_backoff_restart_delay: 200,
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
