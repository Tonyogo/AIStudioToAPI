/* eslint-env jest */
const {
    AuthExpiredError,
    CloudShellController,
    RegionBlockedError,
} = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Lifecycle & Modals", () => {
    test("checkPageStatus detects expired authentication", async () => {
        const mockPage = {
            title: async () => "Sign in - Google Accounts",
            url: () => "https://accounts.google.com/signin/v2/identifier",
        };
        const controller = new CloudShellController(mockPage);
        await expect(controller.checkPageStatus()).rejects.toThrow(AuthExpiredError);
    });

    test("checkPageStatus detects region not available", async () => {
        const mockPage = {
            title: async () => "Available regions - Google Cloud",
            url: () => "https://shell.cloud.google.com/?show=terminal",
        };
        const controller = new CloudShellController(mockPage);
        await expect(controller.checkPageStatus()).rejects.toThrow(RegionBlockedError);
    });

    test("bypassModalsOnce clicks Authorize button if found in frame", async () => {
        let physicalClicked = false;
        let visible = true;
        const mockButton = {
            count: async () => 1,
            first: () => ({
                boundingBox: async () => ({ height: 40, width: 100, x: 200, y: 300 }),
                click: jest.fn().mockResolvedValue(),
                isVisible: async () => visible,
            }),
        };
        const mockFrame = {
            locator: selector => {
                if (selector.includes("Authorize") || selector.includes("授权")) {
                    return mockButton;
                }
                return { count: async () => 0 };
            },
        };
        const mockPage = {
            frames: () => [mockFrame],
            mouse: {
                down: async () => {},
                move: async () => {},
                up: async () => {
                    physicalClicked = true;
                    visible = false;
                },
            },
            title: async () => "Google Cloud Shell",
            url: () => "https://shell.cloud.google.com/?show=terminal",
        };
        const controller = new CloudShellController(mockPage, {
            sleepFn: () => Promise.resolve(),
        });
        const didBypass = await controller.bypassModalsOnce();
        expect(didBypass).toBe(true);
        expect(physicalClicked).toBe(true);
    });
});
