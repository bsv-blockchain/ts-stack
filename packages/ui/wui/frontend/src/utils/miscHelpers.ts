export function generateRandomPrivateKey(): string {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validatePrivateKey(hexKey: string): string {
    if (!/^([a-f0-9]{64})$/.test(hexKey)) {
        return 'Private key must be a 64-character lowercase hex string.';
    }
    return '';
}

/** Return just the domain from a URL (like "dojo.babbage.systems"). */
export function parseDomain(url: string): string {
    try {
        const u = new URL(url);
        return u.hostname;
    } catch {
        return url;
    }
}
