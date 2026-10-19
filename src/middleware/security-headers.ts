import type { Context, Next } from 'hono';

import { config } from '../config';

const CDN_SOURCES = 'https://cdn.jsdelivr.net https://unpkg.com';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' blob: ${CDN_SOURCES}`,
  `style-src 'self' 'unsafe-inline' ${CDN_SOURCES}`,
  "img-src 'self' data:",
  "connect-src 'self'",
  `font-src 'self' data: ${CDN_SOURCES}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function securityHeaders(c: Context, next: Next): Promise<void> {
  await next();

  const headers = c.res.headers;
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);

  if (config.isProduction) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
