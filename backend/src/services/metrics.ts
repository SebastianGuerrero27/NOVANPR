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
// Métricas de Base de Datos
// =============================================================================

export const dbQueryDuration = new promClient.Histogram({
  name: 'anpr_db_query_duration_seconds',
  help: 'Duración de consultas a base de datos en segundos',
  labelNames: ['operation', 'table'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

export const dbQueriesTotal = new promClient.Counter({
  name: 'anpr_db_queries_total',
  help: 'Total de consultas a base de datos',
  labelNames: ['operation', 'table', 'status'],
  registers: [register],
});

export const dbConnectionsActive = new promClient.Gauge({
  name: 'anpr_db_connections_active',
  help: 'Número de conexiones activas a base de datos',
  registers: [register],
});

// =============================================================================
// Métricas de Caché Redis
// =============================================================================

export const cacheHitsTotal = new promClient.Counter({
  name: 'anpr_cache_hits_total',
  help: 'Total de hits en caché',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheMissesTotal = new promClient.Counter({
  name: 'anpr_cache_misses_total',
  help: 'Total de misses en caché',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheOperationsDuration = new promClient.Histogram({
  name: 'anpr_cache_operations_duration_seconds',
  help: 'Duración de operaciones de caché en segundos',
  labelNames: ['operation', 'cache_type'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1],
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

export const websocketMessagesTotal = new promClient.Counter({
  name: 'anpr_websocket_messages_total',
  help: 'Total de mensajes WebSocket',
  labelNames: ['event_type', 'direction'],
  registers: [register],
});

export const websocketErrorsTotal = new promClient.Counter({
  name: 'anpr_websocket_errors_total',
  help: 'Total de errores en WebSocket',
  labelNames: ['error_type'],
  registers: [register],
});

// =============================================================================
// Métricas de ANPR (Detecciones)
// =============================================================================

export const anprDetectionsTotal = new promClient.Counter({
  name: 'anpr_detections_total',
  help: 'Total de detecciones de placas',
  labelNames: ['status', 'camera_id'],
  registers: [register],
});

export const anprOCRDuration = new promClient.Histogram({
  name: 'anpr_ocr_duration_seconds',
  help: 'Duración del proceso OCR en segundos',
  labelNames: ['ocr_engine'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const anprInferenceDuration = new promClient.Histogram({
  name: 'anpr_inference_duration_seconds',
  help: 'Duración de inferencia YOLO en segundos',
  labelNames: ['model_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

export const anprFPS = new promClient.Gauge({
  name: 'anpr_fps',
  help: 'FPS actual del servicio ANPR',
  labelNames: ['camera_id'],
  registers: [register],
});

// =============================================================================
// Métricas de Negocio
// =============================================================================

export const blacklistChecksTotal = new promClient.Counter({
  name: 'anpr_blacklist_checks_total',
  help: 'Total de verificaciones en lista negra',
  labelNames: ['result'],
  registers: [register],
});

export const authorizedChecksTotal = new promClient.Counter({
  name: 'anpr_authorized_checks_total',
  help: 'Total de verificaciones en lista blanca',
  labelNames: ['result'],
  registers: [register],
});

export const validationErrorsTotal = new promClient.Counter({
  name: 'anpr_validation_errors_total',
  help: 'Total de errores de validación',
  labelNames: ['error_type'],
  registers: [register],
});

// =============================================================================
// Middleware para Express
// =============================================================================

export function metricsMiddleware(req: any, res: any, next: any) {
  const start = Date.now();
  
  // Incrementar contador de solicitudes en progreso
  httpRequestsInProgress
    .labels(req.method, req.route?.path || req.path)
    .inc();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    
    // Registrar duración
    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration);
    
    // Registrar solicitud total
    httpRequestsTotal
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .inc();
    
    // Decrementar contador de solicitudes en progreso
    httpRequestsInProgress
      .labels(req.method, req.route?.path || req.path)
      .dec();
  });

  next();
}

// =============================================================================
// Endpoint de Métricas
// =============================================================================

export function getMetrics() {
  return register.metrics();
}

// =============================================================================
// Helper Functions
// =============================================================================

export function incrementCacheHit(cacheType: string) {
  cacheHitsTotal.labels(cacheType).inc();
}

export function incrementCacheMiss(cacheType: string) {
  cacheMissesTotal.labels(cacheType).inc();
}

export function observeCacheDuration(operation: string, cacheType: string, duration: number) {
  cacheOperationsDuration.labels(operation, cacheType).observe(duration);
}

export function observeDBQuery(operation: string, table: string, duration: number, status: string) {
  dbQueryDuration.labels(operation, table).observe(duration);
  dbQueriesTotal.labels(operation, table, status).inc();
}

export function setDBConnections(count: number) {
  dbConnectionsActive.set(count);
}

export function setWebSocketConnections(count: number) {
  websocketConnections.set(count);
}

export function incrementWebSocketMessage(eventType: string, direction: 'in' | 'out') {
  websocketMessagesTotal.labels(eventType, direction).inc();
}

export function incrementWebSocketError(errorType: string) {
  websocketErrorsTotal.labels(errorType).inc();
}

export function incrementANPRDetection(status: string, cameraId: string) {
  anprDetectionsTotal.labels(status, cameraId).inc();
}

export function setANPRFPS(fps: number, cameraId: string) {
  anprFPS.labels(cameraId).set(fps);
}

export function incrementBlacklistCheck(result: 'match' | 'no_match') {
  blacklistChecksTotal.labels(result).inc();
}

export function incrementAuthorizedCheck(result: 'match' | 'no_match') {
  authorizedChecksTotal.labels(result).inc();
}

export function incrementValidationError(errorType: string) {
  validationErrorsTotal.labels(errorType).inc();
}