module.exports = {
  apps: [
    {
      name: "cf-monitoring", // name of the app
      script: "server.js",
      instances: 4,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      log_file: "./logs/pm2-combined.log",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      time: true,
    },
  ],
};
