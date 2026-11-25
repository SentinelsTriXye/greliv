// pm2 start deploy/ecosystem.config.cjs  &&  pm2 save  &&  pm2 startup
module.exports = {
  apps: [
    {
      name: 'vinted-bot',
      script: 'src/index.js',
      cwd: __dirname + '/..',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: '200M',
      env: { TZ: 'Europe/Paris' },
    },
  ],
};
