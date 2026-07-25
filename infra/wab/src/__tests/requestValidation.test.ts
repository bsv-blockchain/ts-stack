import {
    isAuthMethodType,
    isAuthPayload,
    isHexIdentifier,
    isPositiveSafeInteger,
    isRecord,
    isShamirShare
} from "../security/requestValidation";

describe("request validation", () => {
    it("accepts only JSON records as request records and auth payloads", () => {
        expect(isRecord({})).toBe(true);
        expect(isAuthPayload({ phoneNumber: "+14155550100" })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isAuthPayload(null)).toBe(false);
    });

    it("bounds authentication method names and numeric IDs", () => {
        expect(isAuthMethodType("TwilioPhone")).toBe(true);
        expect(isAuthMethodType("../TwilioPhone")).toBe(false);
        expect(isAuthMethodType("a".repeat(65))).toBe(false);
        expect(isPositiveSafeInteger(1)).toBe(true);
        expect(isPositiveSafeInteger(0)).toBe(false);
        expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    });

    it("requires exact 256-bit hexadecimal identifiers", () => {
        expect(isHexIdentifier("ab".repeat(32))).toBe(true);
        expect(isHexIdentifier("ab".repeat(31))).toBe(false);
        expect(isHexIdentifier(`${"ab".repeat(31)}zz`)).toBe(false);
    });

    it("accepts only bounded, structurally valid Shamir shares", () => {
        expect(isShamirShare("2.3.2.deadbeef")).toBe(true);
        expect(isShamirShare("2.3.1.deadbeef")).toBe(false);
        expect(isShamirShare("0.3.2.deadbeef")).toBe(false);
        expect(isShamirShare("2.3.2.deadbeef.extra")).toBe(false);
        expect(isShamirShare("2.3.2.deadbeef".padEnd(257, "x"))).toBe(false);
    });
});
