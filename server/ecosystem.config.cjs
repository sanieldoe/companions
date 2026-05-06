const path = require("path");
const logsDir = path.join(__dirname, "logs");
require("fs").mkdirSync(logsDir, { recursive: true });

module.exports = {
  apps: [
    {
      name: "companion-server",
      script: "dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",
      env_file: ".env",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
  ],
};
