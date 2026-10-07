import crypto from 'crypto';
import { config } from './configuracion';

/**
 * Parámetros de seguridad de las cuentas y tokens de un solo uso. Las reglas de las cuentas
 * (contraseñas, nombres, correos) están en dominio/usuarios.ts y la auditoría pasa por
 * PuertoAuditoria (infraestructura/adaptadores.ts).
 */

export const maxIntentos = () => config.entero('login_max_intentos');
export const minutosBloqueo = () => config.entero('login_minutos_bloqueo');

/** Dominios de correo aceptados (configuración del sistema o ALLOWED_EMAIL_DOMAINS). */
export function dominiosPermitidos(): string[] {
  return config.lista('dominios_correo');
}

/** Token aleatorio para el enlace y su hash SHA-256 (solo el hash se guarda en la base). */
export function generarToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function urlFrontend(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}
