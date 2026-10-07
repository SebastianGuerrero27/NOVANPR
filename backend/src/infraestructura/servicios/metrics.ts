/**
 * Servicio de Métricas con Prometheus
 * 
 * Este servicio proporciona métricas detalladas del sistema ANPR
 * para monitoreo con Prometheus y visualización en Grafana.
 */

import promClient from 'prom-client';

// Configurar el registro de métricas
export const register = new promClient.Registry();

// Métricas por defecto (CPU, memoria, etc.)
promClient.collectDefaultMetrics({
  register,
  prefix: 'anpr_backend_',
});

// =============================================================================
// Métricas HTTP
// =============================================================================

export const httpRequestDuration = new promClient.Histogram({
  name: 'anpr_http_request_duration_seconds',
  help: 'Duración de solicitudes HTTP en segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new promClient.Counter({
  name: 'anpr_http_requests_total',
  help: 'Total de solicitudes HTTP',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestsInProgress = new promClient.Gauge({
  name: 'anpr_http_requests_in_progress',
  help: 'Número de solicitudes HTTP en progreso',
  labelNames: ['method', 'route'],
  registers: [register],
});

// =============================================================================
// Métricas de WebSockets
// =============================================================================

export const websocketConnections = new promClient.Gauge({
  name: 'anpr_websocket_connections',
  help: 'Número de conexiones WebSocket activas',
  registers: [register],
});

// =============================================================================
// Middleware para Express
// =============================================================================

/**
 * Ruta normalizada para las etiquetas: plantilla de Express ("/api/detecciones/:id") en lugar
 * de la URL concreta. Usar req.path generaba una serie temporal por cada id (explosión de
 * cardinalidad en Prometheus) y, además, el contador "en curso" se incrementaba con una
 * etiqueta y se decrementaba con otra, por lo que nunca volvía a cero.
 */
export function rutaNormalizada(req: any): string {
  if (req.route?.path) return `${req.baseUrl || ''}${req.route.path}`;
  return (req.path || '/').replace(/\/\d+(?=\/|$)/g, '/:id');
}

export function metricsMiddleware(req: any, res: any, next: any) {
  const start = process.hrtime.bigint();
  // La etiqueta del contador en curso se fija al inicio y se reutiliza al terminar
  const enCurso = { method: req.method, route: rutaNormalizada(req) };
  httpRequestsInProgress.labels(enCurso.method, enCurso.route).inc();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = rutaNormalizada(req);
    httpRequestDuration.labels(req.method, route, String(res.statusCode)).observe(duration);
    httpRequestsTotal.labels(req.method, route, String(res.statusCode)).inc();
    httpRequestsInProgress.labels(enCurso.method, enCurso.route).dec();
  });

  next();
}

// =============================================================================
// Métricas del centro de notificaciones (evaluación: latencia y tiempo de reconocimiento)
// =============================================================================

export const notificacionesTotal = new promClient.Counter({
  name: 'anpr_notificaciones_total',
  help: 'Notificaciones emitidas por tipo y severidad',
  labelNames: ['tipo', 'severidad'],
  registers: [register],
});

export const notificacionesSuprimidas = new promClient.Counter({
  name: 'anpr_notificaciones_suprimidas_total',
  help: 'Repeticiones agrupadas por la supresión de avalanchas (misma clave dentro de la ventana)',
  labelNames: ['tipo'],
  registers: [register],
});

export const notificacionLatencia = new promClient.Histogram({
  name: 'anpr_notificacion_latencia_seconds',
  help: 'Latencia de extremo a extremo: captura del vehículo → notificación emitida a los destinatarios',
  labelNames: ['tipo'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30],
  registers: [register],
});

export const notificacionReconocimiento = new promClient.Histogram({
  name: 'anpr_notificacion_tiempo_reconocimiento_seconds',
  help: 'Tiempo hasta que una persona reconoce (ACK) una alarma',
  labelNames: ['severidad'],
  buckets: [2, 5, 10, 20, 30, 60, 90, 120, 300, 600],
  registers: [register],
});

export const notificacionesEscaladas = new promClient.Counter({
  name: 'anpr_notificaciones_escaladas_total',
  help: 'Alarmas escaladas por no ser reconocidas a tiempo',
  registers: [register],
});

export const pushEnvios = new promClient.Counter({
  name: 'anpr_push_envios_total',
  help: 'Envíos Web Push por resultado',
  labelNames: ['resultado'],
  registers: [register],
});

// =============================================================================
// Endpoint de Métricas
// =============================================================================

export function getMetrics() {
  return register.metrics();
}

// =============================================================================
// Helper Functions
// =============================================================================

export function setWebSocketConnections(count: number) {
  websocketConnections.set(count);
}
