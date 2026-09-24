/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Anti-Idle Heartbeat", () => {
    test("sendHeartbeat sends Space and Backspace to prevent idle disconnect", async () => {
        const pressedKeys = [];
        const mockPage = {
            frames: () => [],
            isClosed: () => false,
            keyboard: {
                press: async key => {
                    pressedKeys.push(key);
                },
            },
        };
        const controller = new CloudShellController(mockPage);
        await controller.sendHeartbeat();
        expect(pressedKeys).toEqual(["Space", "Backspace"]);
    });

    test("stopKeepAliveLoop halts active loop", () => {
        const mockPage = { isClosed: () => false };
        const controller = new CloudShellController(mockPage);
        controller._keepAliveRunning = true;
        controller.stopKeepAliveLoop();
        expect(controller._keepAliveRunning).toBe(false);
    });
});
