import type { Request } from 'express';

/**
 * IP de origen de la petición (auditoría), hasta 45 caracteres. Express la toma de X-Forwarded-For
 * solo si la conexión llega desde un proxy de confianza (TRUST_PROXY); si no, es la del socket y un
 * cliente no puede falsear la IP registrada enviando esa cabecera.
 */
export function ipDe(req: Request): string {
  return (req.ip || req.socket.remoteAddress || '').substring(0, 45);
}
