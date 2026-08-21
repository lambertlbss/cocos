const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const HEX = '0123456789abcdef';

/** Normalizes Cocos compressed and RFC UUID forms to the protocol identity form. */
export function normalizeCocosUuid(input: string): string {
    const value = input.trim();
    const atIndex = value.indexOf('@');
    const base = atIndex >= 0 ? value.slice(0, atIndex) : value;
    const suffix = atIndex >= 0 ? value.slice(atIndex) : '';
    if (base.length !== 22) return `${base.toLocaleLowerCase()}${suffix}`;

    let hex = base.slice(0, 2).toLocaleLowerCase();
    for (let index = 2; index < 22; index += 2) {
        const left = BASE64_KEYS.indexOf(base[index]!);
        const right = BASE64_KEYS.indexOf(base[index + 1]!);
        if (left < 0 || right < 0) return value.toLocaleLowerCase();
        hex += HEX[left >> 2];
        hex += HEX[((left & 3) << 2) | (right >> 4)];
        hex += HEX[right & 15];
    }
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
        16,
        20,
    )}-${hex.slice(20)}`;
    return `${uuid}${suffix}`;
}
