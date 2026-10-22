'use strict';
// PM2 apps for openGym on Windows (no Docker). Start/refresh with host\build.ps1.
// Both apps read ..\.env (RP_ID, ORIGIN, ACCESS_PIN, ...). Ports and paths are pinned here,
// and env set here wins over .env (node's --env-file never overrides an existing variable).
const path = require('path');
const appRoot = path.resolve(__dirname, '..');
const envFile = path.join(appRoot, '.env');
const logs = path.join(appRoot, 'host', 'logs');

const common = {
  cwd: appRoot,
  instances: 1,
  exec_mode: 'fork',
  node_args: [`--env-file-if-exists=${envFile}`],
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  restart_delay: 3000,
  max_restarts: 10,
  min_uptime: '30s',
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'opengym-api',
      script: path.join(appRoot, 'api', 'server.js'),
      env: {
        NODE_ENV: 'production',
        PORT: '4201',
        DATA_DIR: path.join(appRoot, 'data'),
      },
      error_file: path.join(logs, 'api-error.log'),
      out_file: path.join(logs, 'api-out.log'),
    },
    {
      ...common,
      name: 'opengym-web',
      script: path.join(appRoot, 'host', 'web-shim.mjs'),
      env: {
        NODE_ENV: 'production',
        WEB_PORT: '4200',
        API_TARGET: 'http://127.0.0.1:4201',
        DATA_DIR: path.join(appRoot, 'data'),
      },
      error_file: path.join(logs, 'web-error.log'),
      out_file: path.join(logs, 'web-out.log'),
    },
  ],
};
