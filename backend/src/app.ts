import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { origenesPermitidos } from './services/origenes';
import { archivoDe, DIRECTORIOS_MEDIA, firmaValida } from './services/media';
import { metricsMiddleware, getMetrics, register } from './services/metrics';
import authRoutes from './routes/auth';
import usuariosRoutes from './routes/usuarios';
import camarasRoutes from './routes/camaras';
import deteccionesRoutes from './routes/detecciones';
import { alertasRouter, autorizadosRouter } from './routes/listas';
import panelRoutes from './routes/panel';
import monitoreoRoutes from './routes/monitoreo';
import reportesRoutes from './routes/reportes';
import configuracionRoutes from './routes/configuracion';
import auditoriaRoutes from './routes/auditoria';
import mediosRoutes from './routes/medios';
import cacheRoutes from './routes/cache';
import evaluacionRoutes from './routes/evaluacion';
import propietarioRoutes from './routes/propietario';
import notificacionesRoutes from './routes/notificaciones';
import solicitudesAccesoRoutes from './routes/solicitudesAcceso';

/**
 * Aplicación HTTP (sin efectos secundarios: no conecta la base ni abre puertos). Separarla del
 * arranque (index.ts) permite las pruebas de integración con supertest sobre las rutas reales.
 */
export function crearApp(): express.Express {
  const app = express();

  app.use(cors({
    origin: origenesPermitidos(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
  }));
  app.use(express.json());
  app.use(metricsMiddleware);

  // Evidencia fotográfica: solo con enlace firmado (ver services/media.ts)
  app.get('/media/:archivo', (req, res) => {
    const archivo = archivoDe(req.params.archivo);
    if (!archivo || archivo !== req.params.archivo) return res.status(404).end();
    if (!firmaValida(archivo, req.query.exp, req.query.firma)) return res.status(403).end();
    for (const dir of DIRECTORIOS_MEDIA) {
      const ruta = path.join(dir, archivo);
      if (fs.existsSync(ruta)) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'private, max-age=21600');
        return res.sendFile(ruta);
      }
    }
    return res.status(404).end();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/blacklist', alertasRouter);
  app.use('/api/usuarios', usuariosRoutes);
  app.use('/api/camaras', camarasRoutes);
  app.use('/api/detecciones', deteccionesRoutes);
  app.use('/api/vehiculos-autorizados', autorizadosRouter);
  app.use('/api/panel', panelRoutes);
  app.use('/api/monitoreo', monitoreoRoutes);
  app.use('/api/reportes', reportesRoutes);
  app.use('/api/configuracion', configuracionRoutes);
  app.use('/api/auditoria', auditoriaRoutes);
  app.use('/api/medios', mediosRoutes);
  app.use('/api/cache', cacheRoutes);
  app.use('/api/evaluacion', evaluacionRoutes);
  app.use('/api/propietario', propietarioRoutes);
  app.use('/api/notificaciones', notificacionesRoutes);
  app.use('/api/solicitudes-acceso', solicitudesAccesoRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'OK', service: 'ECU 911 ANPR API', time: new Date() });
  });

  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await getMetrics());
    } catch (error: any) {
      res.status(500).end(error.toString());
    }
  });

  return app;
}
