import express from 'express';
import swaggerUi from 'swagger-ui-express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { origenesPermitidos } from './infraestructura/servicios/origenes';
import { archivoDe, DIRECTORIOS_MEDIA, firmaValida } from './infraestructura/servicios/media';
import { metricsMiddleware, getMetrics, register } from './infraestructura/servicios/metrics';
import authRoutes from './interfaz/http/rutas/auth';
import usuariosRoutes from './interfaz/http/rutas/usuarios';
import camarasRoutes from './interfaz/http/rutas/camaras';
import deteccionesRoutes from './interfaz/http/rutas/detecciones';
import { alertasRouter, autorizadosRouter } from './interfaz/http/rutas/listas';
import panelRoutes from './interfaz/http/rutas/panel';
import monitoreoRoutes from './interfaz/http/rutas/monitoreo';
import reportesRoutes from './interfaz/http/rutas/reportes';
import configuracionRoutes from './interfaz/http/rutas/configuracion';
import auditoriaRoutes from './interfaz/http/rutas/auditoria';
import mediosRoutes from './interfaz/http/rutas/medios';
import evaluacionRoutes from './interfaz/http/rutas/evaluacion';
import propietarioRoutes from './interfaz/http/rutas/propietario';
import notificacionesRoutes from './interfaz/http/rutas/notificaciones';
import solicitudesAccesoRoutes from './interfaz/http/rutas/solicitudesAcceso';
import { generarOpenApi } from './interfaz/http/docs/openapi';

/**
 * Routers de la API y su prefijo. La documentación OpenAPI (interfaz/http/docs/rutas.ts) se contrasta con
 * esta lista en las pruebas: toda ruta montada debe estar documentada.
 */
export const MONTAJES: [string, express.Router][] = [
  ['/api/auth', authRoutes],
  ['/api/blacklist', alertasRouter],
  ['/api/usuarios', usuariosRoutes],
  ['/api/camaras', camarasRoutes],
  ['/api/detecciones', deteccionesRoutes],
  ['/api/vehiculos-autorizados', autorizadosRouter],
  ['/api/panel', panelRoutes],
  ['/api/monitoreo', monitoreoRoutes],
  ['/api/reportes', reportesRoutes],
  ['/api/configuracion', configuracionRoutes],
  ['/api/auditoria', auditoriaRoutes],
  ['/api/medios', mediosRoutes],
  ['/api/evaluacion', evaluacionRoutes],
  ['/api/propietario', propietarioRoutes],
  ['/api/notificaciones', notificacionesRoutes],
  ['/api/solicitudes-acceso', solicitudesAccesoRoutes],
];

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

  // Evidencia fotográfica: solo con enlace firmado (ver infraestructura/servicios/media.ts)
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

  for (const [prefijo, router] of MONTAJES) app.use(prefijo, router);

  // Documentación interactiva (Swagger UI) y especificación OpenAPI. En producción se publica
  // solo con SWAGGER_HABILITADO=true: el catálogo de rutas no debe quedar expuesto por omisión.
  if (process.env.NODE_ENV !== 'production' || process.env.SWAGGER_HABILITADO === 'true') {
    const especificacion = generarOpenApi();
    app.get('/api/docs.json', (_req, res) => res.json(especificacion));
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(especificacion, {
      customSiteTitle: 'ECU 911 ANPR · API',
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true, tagsSorter: 'alpha' },
    }));
  }

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
