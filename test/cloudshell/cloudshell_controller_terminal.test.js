/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Terminal Piercing & Commands", () => {
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

    test("executeCommand focuses terminal and types command with enter", async () => {
        const typed = [];
        const pressed = [];
        let screenClicked = false;

        const mockScreen = {
            click: async () => {
                screenClicked = true;
            },
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
                press: async key => {
                    pressed.push(key);
                },
                type: async text => {
                    typed.push(text);
                },
            },
        };

        const controller = new CloudShellController(mockPage);
        await controller.executeCommand("echo hello");
        expect(screenClicked).toBe(true);
        expect(typed).toContain("echo hello");
        expect(pressed).toContain("Enter");
    });

    test("executeCommands splits multiline command strings into individual lines", async () => {
        const typed = [];
        const pressed = [];

        const mockScreen = {
            click: async () => {},
            count: async () => 1,
            isVisible: async () => true,
        };
        const mockFrame = {
            locator: selector => {
                if (selector.includes(".xterm-screen")) return mockScreen;
                return { count: async () => 0 };
            },
        };
        const mockPage = {
            frames: () => [mockFrame],
            keyboard: {
                press: async key => {
                    pressed.push(key);
                },
                type: async text => {
                    typed.push(text);
                },
            },
        };

        const controller = new CloudShellController(mockPage);
        await controller.executeCommands(["echo 1\necho 2\n# comment line\necho 3"]);

        expect(typed).toEqual(["echo 1", "echo 2", "echo 3"]);
        expect(pressed).toEqual(["Enter", "Enter", "Enter"]);
    });
});
