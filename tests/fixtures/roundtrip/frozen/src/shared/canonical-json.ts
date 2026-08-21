export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function assertUnicodeScalarString(value: string, label = 'string'): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains an unpaired low surrogate`);
    }
  }
}

function normalizeCanonicalValue(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeCanonicalValue(entry, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error(`${path} is not a JSON value`);
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, CanonicalJsonValue> = {};
  for (const key of Object.keys(source).sort()) {
    assertUnicodeScalarString(key, `${path} key`);
    if (source[key] === undefined) throw new Error(`${path}.${key} is undefined`);
    result[key] = normalizeCanonicalValue(source[key], `${path}.${key}`);
  }
  return result;
}

/** RFC 8785/JCS-compatible JSON for JSON-domain values. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value, '$'));
}

/**
 * Parses only a byte-for-byte canonical JSON value. Comparing the parsed value
 * with its canonical serialization also rejects duplicate object members.
 */
export function parseCanonicalJson(input: string): CanonicalJsonValue {
  assertUnicodeScalarString(input, 'JSON input');
  const value: unknown = JSON.parse(input);
  if (canonicalStringify(value) !== input) {
    throw new Error('JSON is not in canonical form');
  }
  return value as CanonicalJsonValue;
}

export function utf8Encode(input: string): Uint8Array {
  assertUnicodeScalarString(input, 'UTF-8 input');
  const bytes: number[] = [];
  for (const character of input) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function utf8ByteLength(input: string): number {
  return utf8Encode(input).byteLength;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(input: string | Uint8Array): string {
  const source = typeof input === 'string' ? utf8Encode(input) : input;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(source);
  padded[source.length] = 0x80;
  const bitLength = source.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choose + SHA256_K[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function sha256(input: string | Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(input)}`;
}

/** Decimal-string, half-away-from-zero quantization. */
export function quantizeDecimal(input: string | number, digits = 4): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
    throw new Error('digits must be an integer between 0 and 12');
  }
  const source = typeof input === 'number' ? input.toString() : input.trim();
  if (typeof input === 'number' && !Number.isFinite(input)) throw new Error('value must be finite');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new Error(`Invalid decimal: ${source}`);
  const negative = match[1] === '-';
  const integer = match[2]!;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  let coefficient = `${integer}${fraction}`.replace(/^0+(?=\d)/, '');
  let decimalPlaces = fraction.length - exponent;
  const discarded = decimalPlaces - digits;
  let scaled: bigint;
  if (discarded <= 0) {
    scaled = BigInt(coefficient) * (10n ** BigInt(-discarded));
  } else {
    coefficient = coefficient.padStart(discarded + 1, '0');
    const split = coefficient.length - discarded;
    scaled = BigInt(coefficient.slice(0, split) || '0');
    if (coefficient.charCodeAt(split) >= 53) scaled += 1n;
  }
  if (negative) scaled = -scaled;
  const result = Number(scaled) / 10 ** digits;
  return Object.is(result, -0) ? 0 : result;
}

export function chunkUtf8(input: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be positive');
  assertUnicodeScalarString(input, 'chunk input');
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of input) {
    const byteLength = utf8ByteLength(character);
    if (byteLength > maxBytes) throw new Error('maxBytes cannot fit one Unicode code point');
    if (current && currentBytes + byteLength > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += byteLength;
  }
  if (current || input.length === 0) chunks.push(current);
  return chunks;
}
