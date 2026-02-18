module.exports = {
  apps: [
    {
      name: "my-assistant",
      script: "src/index.ts",
      interpreter: "/Users/kuro/.bun/bin/bun",
      cwd: "/Users/kuro/dev/my-assistant",
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
