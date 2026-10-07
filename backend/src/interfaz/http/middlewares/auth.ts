import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { cuentaVigente, decodificarToken, type UserPayload } from '../../../contenedor/sesiones';
import { type Permiso, tienePermiso } from '../../../dominio/permisos';

/**
 * Autenticación y autorización de las rutas HTTP: sesión (JWT con el estado vigente de la
 * cuenta), permisos de la matriz de dominio/permisos.ts y token de servicio del motor ANPR.
 */

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sesión requerida.' });
  }
  const payload = decodificarToken(authHeader.split(' ')[1]);
  // 401 (no 403): el frontend lo interpreta como sesión vencida y lleva al login
  if (!payload) return res.status(401).json({ error: 'La sesión expiró o no es válida. Inicie sesión nuevamente.' });
  try {
    const cuenta = await cuentaVigente(payload.id);
    if (!cuenta.vigente) {
      return res.status(401).json({ error: 'Su cuenta fue bloqueada o desactivada. Contacte al administrador.' });
    }
    req.user = { ...payload, rol: cuenta.rol ?? payload.rol };
    next();
  } catch (e: any) {
    console.error('[AUTH] No se pudo verificar la cuenta:', e.message);
    return res.status(503).json({ error: 'No se pudo verificar la sesión. Intente nuevamente.' });
  }
}

/**
 * Exige que el rol de la sesión tenga TODOS los permisos indicados (matriz de
 * dominio/permisos.ts). Es el control que usan los endpoints.
 */
export function requierePermiso(...permisos: Permiso[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Sesión requerida.' });
    if (!permisos.every(p => tienePermiso(req.user!.rol, p))) {
      return res.status(403).json({ error: 'No tiene permisos para esta acción.' });
    }
    next();
  };
}

/**
 * Autenticación máquina a máquina para el microservicio ANPR (registro de capturas y
 * resultados OCR). Compara el encabezado X-Servicio-Token con ANPR_SERVICE_TOKEN en tiempo
 * constante. Si la variable no está definida se rechaza en producción y se permite en
 * desarrollo con una advertencia.
 */
let avisoSinToken = false;
export function servicioMiddleware(req: Request, res: Response, next: NextFunction) {
  const esperado = process.env.ANPR_SERVICE_TOKEN || '';
  if (!esperado) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'ANPR_SERVICE_TOKEN no configurado en el servidor.' });
    }
    if (!avisoSinToken) {
      console.warn('[SEGURIDAD] ANPR_SERVICE_TOKEN no está definido: las rutas del servicio ANPR aceptan cualquier origen (solo desarrollo).');
      avisoSinToken = true;
    }
    return next();
  }
  const recibido = String(req.headers['x-servicio-token'] || '');
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Token de servicio inválido.' });
  }
  next();
}
