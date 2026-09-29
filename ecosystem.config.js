// PM2-Konfiguration: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'wettstube',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
