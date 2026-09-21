/* eslint-env jest */
const RequestHandler = require("../../src/core/RequestHandler");

describe("RequestHandler - X-Account-Name injection", () => {
    let handler;
    let mockAuthSource;
    let mockServerSystem;

    beforeEach(() => {
        mockAuthSource = {
            accountNameMap: new Map([
                [0, "account0@gmail.com"],
                [1, "account1@gmail.com"],
            ]),
            getCanonicalIndex: jest.fn(idx => idx),
        };

        mockServerSystem = {
            usageStatsService: null,
            webRoutes: { authRoutes: { getClientIP: () => "127.0.0.1" } },
        };

        handler = new RequestHandler(
            mockServerSystem,
            {}, // connectionRegistry
            { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }, // logger
            { currentAuthIndex: 0 }, // browserManager
            {}, // config
            mockAuthSource
        );
    });

    test("_injectAccountHeader sets X-Account-Name when account name exists", () => {
        const headers = {};
        const res = {
            headersSent: false,
            setHeader: jest.fn((key, val) => {
                headers[key] = val;
            }),
        };

        handler._injectAccountHeader(res, 0);
        expect(res.setHeader).toHaveBeenCalledWith("X-Account-Name", "account0@gmail.com");
        expect(headers["X-Account-Name"]).toBe("account0@gmail.com");
    });

    test("_injectAccountHeader does nothing when headers are already sent", () => {
        const res = {
            headersSent: true,
            setHeader: jest.fn(),
        };

        handler._injectAccountHeader(res, 0);
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    test("_injectAccountHeader does nothing when account name is not found", () => {
        const res = {
            headersSent: false,
            setHeader: jest.fn(),
        };

        handler._injectAccountHeader(res, 999);
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    test("_sendErrorResponse injects X-Account-Name header when headers are not sent", () => {
        const headers = {};
        const res = {
            headersSent: false,
            json: jest.fn(),
            send: jest.fn(),
            setHeader: jest.fn((key, val) => {
                headers[key] = val;
            }),
            status: jest.fn().mockReturnThis(),
            type: jest.fn().mockReturnThis(),
        };

        handler._sendErrorResponse(res, 500, "Internal Server Error");
        expect(res.setHeader).toHaveBeenCalledWith("X-Account-Name", "account0@gmail.com");
    });
});
