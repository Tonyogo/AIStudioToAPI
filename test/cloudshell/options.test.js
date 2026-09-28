/* eslint-env jest */
const { parseCliArgs, printHelp } = require("../../scripts/cloudshell/options");

describe("CloudShell CLI Options Parser", () => {
    test("returns default values when no args provided", () => {
        const opts = parseCliArgs([]);
        expect(opts.authIndices).toEqual([0]);
        expect(opts.all).toBe(false);
        expect(opts.switchIntervalMinutes).toBe(10);
        expect(opts.keepAliveMinutes).toBe(-1);
        expect(opts.heartbeatIntervalSeconds).toBe(120);
        expect(opts.headless).toBe(true);
        expect(opts.debug).toBe(false);
        expect(opts.help).toBe(false);
        expect(opts.proxy).toBeNull();
    });

    test("parses multi-auth indices and ranges correctly", () => {
        expect(parseCliArgs(["--auth", "0,1,2"]).authIndices).toEqual([0, 1, 2]);
        expect(parseCliArgs(["--auth", "0-3"]).authIndices).toEqual([0, 1, 2, 3]);
        expect(parseCliArgs(["--auth=1,3"]).authIndices).toEqual([1, 3]);
        expect(parseCliArgs(["--auth", "3,1,1,2"]).authIndices).toEqual([1, 2, 3]);
        expect(parseCliArgs(["--all"]).all).toBe(true);
    });

    test("parses custom switch-interval", () => {
        expect(parseCliArgs(["--switch-interval", "15"]).switchIntervalMinutes).toBe(15);
        expect(parseCliArgs(["--switch-interval=5"]).switchIntervalMinutes).toBe(5);
        expect(() => parseCliArgs(["--switch-interval", "-1"])).toThrow(/switch-interval/i);
        expect(() => parseCliArgs(["--switch-interval", "0"])).toThrow(/switch-interval/i);
    });

    test("throws error when cmd or file is provided with helpful deprecation message", () => {
        expect(() => parseCliArgs(["--cmd", "echo 1"])).toThrow(/--cmd is deprecated and no longer supported/i);
        expect(() => parseCliArgs(["--cmd=echo 1"])).toThrow(/--cmd is deprecated and no longer supported/i);
        expect(() => parseCliArgs(["--file", "script.sh"])).toThrow(/--file is deprecated and no longer supported/i);
        expect(() => parseCliArgs(["--file=script.sh"])).toThrow(/--file is deprecated and no longer supported/i);
    });

    test("parses custom options correctly", () => {
        const args = [
            "--auth",
            "2",
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
        expect(opts.authIndices).toEqual([2]);
        expect(opts.keepAliveMinutes).toBe(30);
        expect(opts.heartbeatIntervalSeconds).toBe(60);
        expect(opts.headless).toBe(false);
        expect(opts.proxy).toBe("http://127.0.0.1:7890");
        expect(opts.debug).toBe(true);
    });

    test("parses explicit --headless arguments", () => {
        expect(parseCliArgs(["--headless=false"]).headless).toBe(false);
        expect(parseCliArgs(["--headless", "false"]).headless).toBe(false);
        expect(parseCliArgs(["--headless=0"]).headless).toBe(false);
        expect(parseCliArgs(["--headless", "0"]).headless).toBe(false);
        expect(parseCliArgs(["--headless=true"]).headless).toBe(true);
        expect(parseCliArgs(["--headless", "true"]).headless).toBe(true);
        expect(parseCliArgs(["--headless"]).headless).toBe(true);
        expect(parseCliArgs(["--headed"]).headless).toBe(false);
    });

    test("throws error when auth index is invalid or negative", () => {
        expect(() => parseCliArgs(["--auth", "-1"])).toThrow(/auth index/i);
        expect(() => parseCliArgs(["--auth", "abc"])).toThrow(/auth index/i);
    });

    test("parses subcommands start, stop, status, restart, logs correctly", () => {
        expect(parseCliArgs(["start", "--auth", "0,1"]).command).toBe("start");
        expect(parseCliArgs(["stop"]).command).toBe("stop");
        expect(parseCliArgs(["status"]).command).toBe("status");
        expect(parseCliArgs(["restart", "--all"]).command).toBe("restart");
        expect(parseCliArgs(["logs", "-f"]).command).toBe("logs");
    });

    test("parses pause and resume subcommands correctly", () => {
        expect(parseCliArgs(["pause"]).command).toBe("pause");
        expect(parseCliArgs(["resume"]).command).toBe("resume");
    });

    test("defaults command to status when no subcommand provided", () => {
        const opts = parseCliArgs([]);
        expect(opts.command).toBe("status");
    });

    test("parses --foreground, --force, --follow flags", () => {
        expect(parseCliArgs(["start", "--foreground"]).foreground).toBe(true);
        expect(parseCliArgs(["start", "-f"]).foreground).toBe(true);
        expect(parseCliArgs(["stop", "--force"]).force).toBe(true);
        expect(parseCliArgs(["logs", "--follow"]).follow).toBe(true);
        expect(parseCliArgs(["logs", "-f"]).follow).toBe(true);
    });

    test("enables foreground automatically when --headed is passed to start", () => {
        const opts = parseCliArgs(["start", "--headed"]);
        expect(opts.headless).toBe(false);
        expect(opts.foreground).toBe(true);
    });

    test("throws error when unknown subcommand provided", () => {
        expect(() => parseCliArgs(["invalidCommand"])).toThrow(/unknown command/i);
    });

    test("printHelp does not throw", () => {
        const spy = jest.spyOn(console, "log").mockImplementation(() => {});
        expect(() => printHelp()).not.toThrow();
        spy.mockRestore();
    });
});
