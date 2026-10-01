/**
 * Tests para el servicio de métricas
 */

import {
  httpRequestDuration,
  httpRequestsTotal,
  dbQueryDuration,
  cacheHitsTotal,
  incrementCacheHit,
  incrementCacheMiss,
  observeDBQuery,
  setDBConnections,
  register,
} from '../../services/metrics';

describe('Metrics Service', () => {
  beforeEach(() => {
    // Resetear métricas antes de cada test
    register.resetMetrics();
  });

  describe('HTTP Metrics', () => {
    it('debería registrar duración de solicitud HTTP', async () => {
      httpRequestDuration.labels('GET', '/api/test', '200').observe(0.5);
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_http_request_duration_seconds');
    });

    it('debería incrementar contador de solicitudes HTTP', async () => {
      httpRequestsTotal.labels('GET', '/api/test', '200').inc();
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_http_requests_total');
    });
  });

  describe('Database Metrics', () => {
    it('debería registrar duración de consulta BD', async () => {
      dbQueryDuration.labels('SELECT', 'Usuarios').observe(0.1);
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_db_query_duration_seconds');
    });

    it('debería establecer número de conexiones activas', async () => {
      setDBConnections(5);
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_db_connections_active');
    });
  });

  describe('Cache Metrics', () => {
    it('debería incrementar hits de caché', async () => {
      incrementCacheHit('blacklist');
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_cache_hits_total');
    });

    it('debería incrementar misses de caché', async () => {
      incrementCacheMiss('blacklist');
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_cache_misses_total');
    });
  });

  describe('Helper Functions', () => {
    it('debería incrementar cache hit correctamente', async () => {
      incrementCacheHit('blacklist');
      incrementCacheHit('blacklist');
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_cache_hits_total{cache_type="blacklist"} 2');
    });

    it('debería observar duración de consulta BD', async () => {
      observeDBQuery('SELECT', 'Usuarios', 0.15, 'success');
      
      const metrics = await register.metrics();
      expect(metrics).toContain('anpr_db_query_duration_seconds');
    });
  });

  describe('Middleware HTTP', () => {
    it('usa la plantilla de la ruta (no la URL concreta) y el contador en curso vuelve a cero', async () => {
      const { metricsMiddleware, rutaNormalizada } = await import('../../services/metrics');
      expect(rutaNormalizada({ baseUrl: '/api/detecciones', route: { path: '/:id(\\d+)' } })).toBe('/api/detecciones/:id(\\d+)');
      expect(rutaNormalizada({ path: '/api/detecciones/1234/foto' })).toBe('/api/detecciones/:id/foto');

      const oyentes: Record<string, () => void> = {};
      const req: any = { method: 'GET', path: '/api/detecciones/77' };
      const res: any = { statusCode: 200, on: (ev: string, fn: () => void) => { oyentes[ev] = fn; } };
      metricsMiddleware(req, res, () => undefined);
      req.baseUrl = '/api/detecciones';
      req.route = { path: '/:id' };
      oyentes.finish();
      const texto = await register.metrics();
      expect(texto).toContain('anpr_http_requests_total{method="GET",route="/api/detecciones/:id",status_code="200"} 1');
      expect(texto).toContain('anpr_http_requests_in_progress{method="GET",route="/api/detecciones/:id"} 0');
      expect(texto).not.toContain('/api/detecciones/77');
    });
  });
});
