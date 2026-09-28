/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Terminal Piercing & Focus", () => {
    test("findTerminalTarget locates xterm in child frame", async () => {
        const mockScreen = {
            click: async () => {},
            count: async () => 1,
            isVisible: async () => true,
        };
        const mockTextarea = {
            count: async () => 1,
            focus: async () => {},
            isVisible: async () => true,
        };

        const mockFrame = {
            locator: selector => {
                if (selector.includes("textarea.xterm-helper-textarea")) {
                    return mockTextarea;
                }
                if (selector.includes(".xterm-screen")) {
                    return mockScreen;
                }
                return { count: async () => 0 };
            },
        };

        const mockPage = {
            frames: () => [mockFrame],
            keyboard: {
                press: async () => {},
                type: async () => {},
            },
        };

        const controller = new CloudShellController(mockPage);
        const target = await controller.findTerminalTarget();
        expect(target).not.toBeNull();
        expect(target.screen).toBe(mockScreen);
        expect(target.textarea).toBe(mockTextarea);
    });

    test("focusTerminal clicks screen and focuses textarea", async () => {
        let screenClicked = false;
        let textareaFocused = false;

        const mockScreen = {
            click: async () => {
                screenClicked = true;
            },
            count: async () => 1,
            isVisible: async () => true,
        };
        const mockTextarea = {
            count: async () => 1,
            focus: async () => {
                textareaFocused = true;
            },
            isVisible: async () => true,
        };
        const mockFrame = {
            locator: selector => {
                if (selector.includes("textarea.xterm-helper-textarea")) {
                    return mockTextarea;
                }
                if (selector.includes(".xterm-screen")) {
                    return mockScreen;
                }
                return { count: async () => 0 };
            },
        };

        const mockPage = {
            frames: () => [mockFrame],
            keyboard: {
                press: async () => {},
            },
        };

        const controller = new CloudShellController(mockPage);
        const result = await controller.focusTerminal();
        expect(result).toBe(true);
        expect(screenClicked).toBe(true);
        expect(textareaFocused).toBe(true);
    });
});
