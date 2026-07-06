module.exports = {
  apps: [
    {
      name: "falcao-crawler",
      script: "npm",
      args: "run falcao",
      cwd: "/opt/jurisprudencia-crawlers/app",
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "400M",
      autorestart: true,
      watch: false,
    },
  ],
};
