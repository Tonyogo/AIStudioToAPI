/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const AuthSource = require("../../src/auth/AuthSource");

describe("AuthSource disabled functionality", () => {
    const mockLogger = {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    };
    const testConfigDir = path.join(process.cwd(), "configs", "auth");

    beforeEach(() => {
        if (!fs.existsSync(testConfigDir)) {
            fs.mkdirSync(testConfigDir, { recursive: true });
        }
    });

    test("_preValidateAndFilter categorizes disabled accounts into disabledIndices and excludes from rotationIndices", () => {
        const auth0Path = path.join(testConfigDir, "auth-990.json");
        const auth1Path = path.join(testConfigDir, "auth-991.json");

        fs.writeFileSync(auth0Path, JSON.stringify({ cookies: [], disabled: true, email: "disabled@example.com" }));
        fs.writeFileSync(auth1Path, JSON.stringify({ cookies: [], email: "active@example.com" }));

        try {
            const authSource = new AuthSource(mockLogger);
            expect(authSource.disabledIndices).toContain(990);
            expect(authSource.rotationIndices).not.toContain(990);
            expect(authSource.rotationIndices).toContain(991);
        } finally {
            if (fs.existsSync(auth0Path)) fs.unlinkSync(auth0Path);
            if (fs.existsSync(auth1Path)) fs.unlinkSync(auth1Path);
        }
    });

    test("toggleDisabled updates auth file and reloads sources", () => {
        const authPath = path.join(testConfigDir, "auth-992.json");
        fs.writeFileSync(authPath, JSON.stringify({ cookies: [], email: "test@example.com" }));

        try {
            const authSource = new AuthSource(mockLogger);
            expect(authSource.rotationIndices).toContain(992);

            authSource.toggleDisabled(992, true);
            expect(authSource.disabledIndices).toContain(992);
            expect(authSource.rotationIndices).not.toContain(992);

            const fileContent = JSON.parse(fs.readFileSync(authPath, "utf8"));
            expect(fileContent.disabled).toBe(true);

            authSource.toggleDisabled(992, false);
            expect(authSource.disabledIndices).not.toContain(992);
            expect(authSource.rotationIndices).toContain(992);

            const fileContent2 = JSON.parse(fs.readFileSync(authPath, "utf8"));
            expect(fileContent2.disabled).toBeUndefined();
        } finally {
            if (fs.existsSync(authPath)) fs.unlinkSync(authPath);
        }
    });
});
