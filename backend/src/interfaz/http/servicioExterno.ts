import type { Request, Response } from 'express';
import { ErrorAplicacion } from '../../aplicacion/comun';
import { controlador } from './respuesta';

/**
 * Variante de controlador() para las operaciones que dependen de un servicio externo (servidor
 * de video MediaMTX o motor ANPR): los ErrorAplicacion se responden igual (400, 403, 404, 409)
 * y un fallo no previsto responde 502 Bad Gateway en lugar de 500, sin exponer el detalle.
 */
export function controladorExterno(contexto: string, mensaje502: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  return controlador(contexto, mensaje502, async (req, res) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      if (e instanceof ErrorAplicacion) throw e;
      console.error(`[${contexto}]`, e?.message ?? e);
      if (!res.headersSent) res.status(502).json({ error: mensaje502 });
    }
  });
}
