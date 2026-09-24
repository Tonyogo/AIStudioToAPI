/* eslint-env jest */
const { parseCliArgs, printHelp } = require("../../scripts/cloudshell/options");

describe("CloudShell CLI Options Parser", () => {
    test("returns default values when no args provided", () => {
        const opts = parseCliArgs([]);
        expect(opts.authIndex).toBe(0);
        expect(opts.cmd).toBeNull();
        expect(opts.filePath).toBeNull();
        expect(opts.keepAliveMinutes).toBe(0);
        expect(opts.heartbeatIntervalSeconds).toBe(120);
        expect(opts.headless).toBe(true);
        expect(opts.debug).toBe(false);
        expect(opts.help).toBe(false);
    });

    test("parses custom options correctly", () => {
        const args = [
            "--auth",
            "2",
            "--cmd",
            "echo test",
            "--keep-alive",
            "30",
            "--heartbeat-interval",
            "60",
            "--headed",
            "--proxy",
            "http://127.0.0.1:7890",
            "--debug",
        ];
        const opts = parseCliArgs(args);
        expect(opts.authIndex).toBe(2);
        expect(opts.cmd).toBe("echo test");
        expect(opts.keepAliveMinutes).toBe(30);
        expect(opts.heartbeatIntervalSeconds).toBe(60);
        expect(opts.headless).toBe(false);
        expect(opts.proxy).toBe("http://127.0.0.1:7890");
        expect(opts.debug).toBe(true);
    });

    test("parses equals syntax like --auth=3", () => {
        const args = ["--auth=3", "--cmd=ls -la", "--keep-alive=-1"];
        const opts = parseCliArgs(args);
        expect(opts.authIndex).toBe(3);
        expect(opts.cmd).toBe("ls -la");
        expect(opts.keepAliveMinutes).toBe(-1);
    });

    test("throws error when auth index is negative", () => {
        expect(() => parseCliArgs(["--auth", "-1"])).toThrow(/auth index/i);
    });

    test("printHelp does not throw", () => {
        const spy = jest.spyOn(console, "log").mockImplementation(() => {});
        expect(() => printHelp()).not.toThrow();
        spy.mockRestore();
    });
});
