import { Router } from 'express';
import { medios } from '../../../contenedor/camaras';

/**
 * Autorización de MediaMTX (authMethod: http). MediaMTX consulta este endpoint antes de cada
 * lectura o publicación y solo continúa si la respuesta es 2xx; la respuesta no lleva cuerpo.
 * Ante cualquier fallo se deniega (401). Las reglas están en aplicacion/medios.ts.
 */
const router = Router();

/** Solo se aceptan textos: cualquier otro tipo cuenta como campo vacío (y se deniega). */
const texto = (valor: unknown) => (typeof valor === 'string' ? valor : '');

router.post('/autorizar', async (req, res) => {
  const b = req.body ?? {};
  let autorizado = false;
  try {
    autorizado = await medios.autorizarLectura({
      user: texto(b.user), password: texto(b.password), action: texto(b.action),
      path: texto(b.path), protocol: texto(b.protocol), query: texto(b.query),
    });
  } catch (e: any) {
    console.error('[MEDIOS] autorizar:', e?.message ?? e);
  }
  res.status(autorizado ? 200 : 401).end();
});

export default router;
