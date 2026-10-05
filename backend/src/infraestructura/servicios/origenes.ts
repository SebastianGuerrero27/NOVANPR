/**
 * Orígenes del navegador autorizados para la API y Socket.IO (CORS_ORIGINS, separados por
 * coma). Por omisión, la URL del frontend. Un '*' explícito solo se admite fuera de producción.
 */
export function origenesPermitidos(): string[] | string {
  const lista = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
  if (lista.includes('*')) return process.env.NODE_ENV === 'production' ? lista.filter(o => o !== '*') : '*';
  return lista;
}
