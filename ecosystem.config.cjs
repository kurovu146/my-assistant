const os = require("os");
const path = require("path");

const homeDir = os.homedir();
const bunPath = path.join(homeDir, ".bun", "bin", "bun");
const cwd = __dirname;

module.exports = {
  apps: [
    {
      name: "my-assistant",
      script: "src/index.ts",
      interpreter: bunPath,
      cwd,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        PATH: `${path.join(homeDir, ".bun", "bin")}:${process.env.PATH}`,
      },
    },
  ],
};
