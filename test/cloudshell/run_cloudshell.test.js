/* eslint-env jest */
const { spawnSync } = require("child_process");
const path = require("path");

describe("CloudShell CLI Entrypoint Smoke Test", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "cloudshell", "runCloudShell.js");

    test("--help outputs usage and exits with 0", () => {
        const res = spawnSync("node", [scriptPath, "--help"], {
            encoding: "utf-8",
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Usage: node scripts/cloudshell/runCloudShell.js");
        expect(res.stdout).toContain("--auth <index>");
    });

    test("missing auth file exits with error code 1 and helpful message", () => {
        const res = spawnSync("node", [scriptPath, "--auth", "987654"], {
            encoding: "utf-8",
        });
        expect(res.status).toBe(1);
        expect(res.stderr || res.stdout).toContain("auth-987654.json does not exist");
    });
});
