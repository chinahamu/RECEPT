import type { IncomingMessage } from 'node:http';

const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalRequest(req: IncomingMessage) {
  return loopbackHost.test(req.headers.host ?? '') && loopbackAddresses.has(req.socket.remoteAddress ?? '');
}

export function isSameOriginApiRequest(req: IncomingMessage) {
  const { host, origin, 'sec-fetch-site': fetchSite } = req.headers;
  const scheme = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http';
  return isLocalRequest(req) && (origin === undefined || origin === `${scheme}://${host}`) &&
    (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none');
}

export const protectedResponseHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
