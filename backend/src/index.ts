import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { connectDB } from './config/db';
import { initSocket } from './services/socket';
import { metricsMiddleware, getMetrics, register } from './services/metrics';
import authRoutes from './routes/auth';
import eventosRoutes from './routes/eventos';
import blacklistRoutes from './routes/blacklist';
import usuariosRoutes from './routes/usuarios';
import camarasRoutes from './routes/camaras';
import camarasMultiRoutes from './routes/camaras-multi';
import deteccionesRoutes from './routes/detecciones';
import vehiculosAutorizadosRoutes from './routes/vehiculos-autorizados';
import cacheRoutes from './routes/cache';
import path from 'path';
import fs from 'fs';

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 5000;

// Configuración de CORS
app.use(cors({
  origin: '*', // Permitir cualquier origen en entorno local/pruebas
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Middleware de métricas Prometheus
app.use(metricsMiddleware);

// Exponer las carpetas de imágenes multimedia para que el frontend pueda visualizarlas
app.use('/media', (req, res, next) => {
  const filename = path.basename(req.path);
  if (!filename || filename === '.' || filename === '/') {
    return next();
  }

  const possiblePaths = [
    path.resolve(process.cwd(), '../services/anpr/media', filename),
    path.resolve(process.cwd(), 'services/anpr/media', filename),
    path.resolve(__dirname, '../../services/anpr/media', filename),
    path.resolve(__dirname, '../services/anpr/media', filename),
    path.resolve(__dirname, '../media', filename),
    path.resolve(__dirname, '../../media', filename),
    path.resolve(process.cwd(), 'media', filename),
    path.resolve('/app/media', filename),
    path.resolve('/app/services/anpr/media', filename),
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(filePath);
    }
  }

  return res.status(404).send('Media not found');
});

// Rutas de la API
app.use('/api/auth', authRoutes);
app.use('/api/eventos', eventosRoutes);
app.use('/api/blacklist', blacklistRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/camaras', camarasRoutes);
app.use('/api/camaras', camarasMultiRoutes);
app.use('/api/detecciones', deteccionesRoutes);
app.use('/api/vehiculos-autorizados', vehiculosAutorizadosRoutes);
app.use('/api/cache', cacheRoutes);

// Endpoint simple de estado de la cámara
app.get('/api/camera/stream-url', (req, res) => {
  // Retorna la url HLS del MediaMTX expuesta para el cliente
  // En Docker, el cliente (navegador) accederá al puerto 8888 de localhost/host
  return res.json({ 
    streamUrl: `http://${req.hostname}:8888/camera/index.m3u8`
  });
});

// Ruta base/Healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'ECU 911 ANPR API', time: new Date() });
});

// Endpoint de métricas Prometheus
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await getMetrics());
  } catch (error: any) {
    res.status(500).end(error.toString());
  }
});

// Arrancar servidor
async function startServer() {
  try {
    // Conectar a Base de Datos SQL Server con reintentos
    await connectDB();

    // Inicializar WebSockets
    initSocket(server);

    server.listen(PORT, () => {
      console.log(`===================================================`);
      console.log(`  ECU 911 ANPR Backend iniciado en puerto ${PORT}`);
      console.log(`  Entorno: ${process.env.NODE_ENV || 'development'}`);
      console.log(`  Media Estática expuesta en: http://localhost:${PORT}/media`);
      console.log(`===================================================`);
    });
  } catch (error: any) {
    console.error('Error catastrófico al iniciar el backend:', error.message);
    process.exit(1);
  }
}

startServer();
