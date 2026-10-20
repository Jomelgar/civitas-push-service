import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import { config } from '../config';

export const API_KEY_PREFIX = 'cva_';
export const API_KEY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

export function hashApiKey(key: string): string {
  return createHmac('sha256', config.apiKeyPepper).update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    key,
    prefix: key.slice(0, API_KEY_PREFIX_LENGTH),
    keyHash: hashApiKey(key),
  };
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice('::ffff:'.length);
  return ip;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let working = ip;
  if (working.includes('.')) {
    const lastColon = working.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = ipv4ToBigInt(working.slice(lastColon + 1));
    if (v4 === null) return null;
    const high = Number((v4 >> 16n) & 0xffffn).toString(16);
    const low = Number(v4 & 0xffffn).toString(16);
    working = `${working.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = working.split('::');
  if (halves.length > 2) return null;

  const expand = (segment: string) =>
    segment ? segment.split(':').filter((group) => group !== '') : [];
  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function cidrMatch(ip: string, entry: string): boolean {
  if (!validIpEntry(entry)) return false;
  const [range, bitsRaw] = entry.split('/');
  const bits = bitsRaw === undefined ? undefined : Number(bitsRaw);

  const ip4 = ipv4ToBigInt(ip);
  const range4 = range ? ipv4ToBigInt(range) : null;
  if (ip4 !== null && range4 !== null) {
    const width = 32;
    const prefix = bits ?? width;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
    const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix));
    return (ip4 & mask) === (range4 & mask);
  }

  const ip6 = ipv6ToBigInt(ip);
  const range6 = range ? ipv6ToBigInt(range) : null;
  if (ip6 !== null && range6 !== null) {
    const width = 128;
    const prefix = bits ?? width;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
    const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix));
    return (ip6 & mask) === (range6 & mask);
  }

  return false;
}

export function validIpEntry(entry: string): boolean {
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const version = isIP(parts[0] ?? '');
  if (!version) return false;
  if (parts.length === 1) return true;
  const prefix = parts[1]!;
  return /^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

export function matchIpAllowlist(ip: string | undefined, allowlist: string): boolean {
  const entries = allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return true;
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  return entries.some((entry) => cidrMatch(normalized, entry));
}
