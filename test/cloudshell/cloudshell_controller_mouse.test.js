/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Anti-Detection Mouse Movement", () => {
    test("simulateHumanMovement splits path into 3 segments with smooth step moves", async () => {
        const moves = [];
        const mockPage = {
            isClosed: () => false,
            mouse: {
                move: async (x, y, options) => {
                    moves.push({ options, x, y });
                },
            },
        };
        const controller = new CloudShellController(mockPage);
        await controller.simulateHumanMovement(500, 300);

        expect(moves.length).toBe(3);
        // The last segment must hit exact destination
        expect(moves[2].x).toBe(500);
        expect(moves[2].y).toBe(300);
        expect(moves[2].options.steps).toBeGreaterThanOrEqual(5);
    });

    test("performActiveMicroActions executes corner reset every 15 ticks", async () => {
        const moves = [];
        const mockPage = {
            evaluate: async () => {},
            isClosed: () => false,
            mouse: {
                move: async (x, y) => moves.push({ x, y }),
            },
            viewportSize: () => ({ height: 1080, width: 1920 }),
        };
        const controller = new CloudShellController(mockPage);
        await controller.performActiveMicroActions(15);

        // tick 15 triggers corner reset to (1, 1)
        expect(moves.some(m => m.x === 1 && m.y === 1)).toBe(true);
    });
});
