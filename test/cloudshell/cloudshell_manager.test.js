/* eslint-env jest */
const { CloudShellManager } = require("../../scripts/cloudshell/CloudShellManager");

describe("CloudShellManager Multi-Context Lifecycle", () => {
    test("initializes contexts and sets first account as active", async () => {
        const mockPage0 = {
            bringToFront: jest.fn().mockResolvedValue(),
            isClosed: () => false,
            mouse: { move: jest.fn().mockResolvedValue() },
            viewportSize: () => ({ height: 1080, width: 1920 }),
        };
        const mockContext0 = { newPage: jest.fn().mockResolvedValue(mockPage0) };

        const mockBrowser = {
            newContext: jest.fn().mockResolvedValue(mockContext0),
        };

        const manager = new CloudShellManager(mockBrowser, {
            authIndices: [0, 1],
            keepAliveMinutes: 0,
            switchIntervalMinutes: 10,
        });

        expect(manager.authIndices).toEqual([0, 1]);
        expect(manager.currentAuthIndex).toBe(0);
    });

    test("rotates active context correctly on switch interval", async () => {
        const manager = new CloudShellManager(null, {
            authIndices: [0, 1, 2],
            switchIntervalMinutes: 10,
        });
        manager.currentAuthIndex = 0;

        const next1 = manager.getNextAuthIndex();
        expect(next1).toBe(1);
        manager.currentAuthIndex = 1;

        const next2 = manager.getNextAuthIndex();
        expect(next2).toBe(2);
        manager.currentAuthIndex = 2;

        const next3 = manager.getNextAuthIndex();
        expect(next3).toBe(0);
    });

    test("switchActiveContext brings page to front and triggers human movement", async () => {
        const mockPage = {
            bringToFront: jest.fn().mockResolvedValue(),
            evaluate: jest.fn().mockResolvedValue(),
            isClosed: () => false,
            viewportSize: () => ({ height: 1080, width: 1920 }),
        };
        const mockController = {
            simulateHumanMovement: jest.fn().mockResolvedValue(),
        };

        const manager = new CloudShellManager(null, {
            authIndices: [0, 1],
        });
        manager.contexts.set(1, {
            context: {},
            controller: mockController,
            page: mockPage,
        });

        await manager.switchActiveContext(1);
        expect(manager.currentAuthIndex).toBe(1);
        expect(mockPage.bringToFront).toHaveBeenCalled();
        expect(mockController.simulateHumanMovement).toHaveBeenCalled();
    });

    test("discoverAvailableAuthIndices extracts indices from files", () => {
        const fs = require("fs");
        const spyExists = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        const spyReaddir = jest
            .spyOn(fs, "readdirSync")
            .mockReturnValue(["auth-0.json", "auth-2.json", "auth-1.json", "other.json"]);

        const indices = CloudShellManager.discoverAvailableAuthIndices();
        expect(indices).toEqual([0, 1, 2]);

        spyExists.mockRestore();
        spyReaddir.mockRestore();
    });

    test("stop halts keep-alive loop and closes all contexts", async () => {
        const closeContext0 = jest.fn().mockResolvedValue();
        const closeContext1 = jest.fn().mockResolvedValue();
        const stopKeepAlive = jest.fn();

        const manager = new CloudShellManager(null, { authIndices: [0, 1] });
        manager.contexts.set(0, {
            context: { close: closeContext0 },
            controller: { stopKeepAliveLoop: stopKeepAlive },
            page: {},
        });
        manager.contexts.set(1, {
            context: { close: closeContext1 },
            controller: { stopKeepAliveLoop: stopKeepAlive },
            page: {},
        });

        manager._running = true;
        await manager.stop();

        expect(manager._running).toBe(false);
        expect(closeContext0).toHaveBeenCalled();
        expect(closeContext1).toHaveBeenCalled();
        expect(stopKeepAlive).toHaveBeenCalledTimes(2);
        expect(manager.contexts.size).toBe(0);
    });
});
