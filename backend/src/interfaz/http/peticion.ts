import type { Request } from 'express';

/** IP de origen de la petición (primer salto de X-Forwarded-For detrás del proxy), hasta 45 caracteres. */
export function ipDe(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '').substring(0, 45);
}
