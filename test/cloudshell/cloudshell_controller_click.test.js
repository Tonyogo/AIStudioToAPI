/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Simulated Click & Fallback", () => {
    test("clickElementSimulated performs smooth move and mouse down/up on button center", async () => {
        const mouseEvents = [];
        const mockPage = {
            isClosed: () => false,
            mouse: {
                down: async () => mouseEvents.push("down"),
                move: async (x, y) => mouseEvents.push({ type: "move", x, y }),
                up: async () => {
                    mouseEvents.push("up");
                    visible = false;
                },
            },
        };

        const controller = new CloudShellController(mockPage);
        // Spy simulateHumanMovement
        const moveSpy = jest.spyOn(controller, "simulateHumanMovement").mockResolvedValue();

        let visible = true;
        const mockLocator = {
            boundingBox: async () => ({ height: 40, width: 100, x: 200, y: 300 }),
            click: jest.fn().mockResolvedValue(),
            isVisible: async () => visible,
        };

        const result = await controller.clickElementSimulated(mockLocator, "Authorize");
        expect(result).toBe(true);
        expect(moveSpy).toHaveBeenCalled();
        const [targetX, targetY] = moveSpy.mock.calls[0];
        // Target coordinates must fall inside button bounding box (200~300, 300~340)
        expect(targetX).toBeGreaterThanOrEqual(200);
        expect(targetX).toBeLessThanOrEqual(300);
        expect(targetY).toBeGreaterThanOrEqual(300);
        expect(targetY).toBeLessThanOrEqual(340);

        expect(mouseEvents).toContain("down");
        expect(mouseEvents).toContain("up");
        // Fallback JS click should NOT be called since button disappeared
        expect(mockLocator.click).not.toHaveBeenCalled();
    });

    test("clickElementSimulated falls back to JS click when button remains visible", async () => {
        const mockPage = {
            isClosed: () => false,
            mouse: {
                down: async () => {},
                up: async () => {},
            },
        };

        const controller = new CloudShellController(mockPage);
        jest.spyOn(controller, "simulateHumanMovement").mockResolvedValue();

        const mockLocator = {
            boundingBox: async () => ({ height: 40, width: 100, x: 200, y: 300 }),
            click: jest.fn().mockResolvedValue(),
            isVisible: async () => true, // button still visible after physical click
        };

        const result = await controller.clickElementSimulated(mockLocator, "Authorize");
        expect(result).toBe(true);
        // Fallback JS click MUST be triggered
        expect(mockLocator.click).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    });
});
