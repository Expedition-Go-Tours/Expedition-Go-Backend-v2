module.exports = {
  apps: [{
    name: 'expedition-api',
    script: 'server.js',
    cwd: '/home/deploy/Expedition-Go-Backend-v2',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    max_memory_restart: '350M',
    error_file: '/home/deploy/logs/err.log',
    out_file: '/home/deploy/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    watch: false
  }]
};
