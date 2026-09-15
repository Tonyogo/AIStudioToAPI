module.exports = {
    apps: [
        {
            name: "aistudio-to-api",
            script: "main.js",
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "2G",
            kill_timeout: 10000,
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
