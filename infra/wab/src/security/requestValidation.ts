import { AuthPayload } from "../auth-methods/AuthMethod";

const HEX_256 = /^[0-9a-fA-F]{64}$/;
const AUTH_METHOD_TYPE = /^[a-zA-Z0-9_-]{1,64}$/;
const BASE58_FIELD = /^[1-9A-HJ-NP-Za-km-z]{1,64}$/;
const INTEGRITY_TAG = /^[0-9a-fA-F]{8}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAuthPayload(value: unknown): value is AuthPayload {
    return isRecord(value);
}

export function isAuthMethodType(value: unknown): value is string {
    return typeof value === "string" && AUTH_METHOD_TYPE.test(value);
}

export function isHexIdentifier(value: unknown): value is string {
    return typeof value === "string" && HEX_256.test(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate the SDK KeyShares backup representation without parsing attacker
 * input into large numeric objects. The SDK performs full integrity validation
 * when shares are recombined; WAB only needs a bounded storage contract.
 */
export function isShamirShare(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 256) return false;
    const [x, y, thresholdText, integrity, extra] = value.split(".");
    if (
        extra !== undefined ||
        x === undefined ||
        y === undefined ||
        thresholdText === undefined ||
        integrity === undefined
    ) {
        return false;
    }
    if (!BASE58_FIELD.test(x) || !BASE58_FIELD.test(y)) return false;
    if (!/^[0-9]{1,3}$/.test(thresholdText)) return false;
    const threshold = Number.parseInt(thresholdText, 10);
    return threshold >= 2 && threshold <= 255 && INTEGRITY_TAG.test(integrity);
}
