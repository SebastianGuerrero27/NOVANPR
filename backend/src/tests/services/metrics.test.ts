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
    it('debería registrar duración de solicitud HTTP', () => {
      httpRequestDuration.labels('GET', '/api/test', '200').observe(0.5);
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_http_request_duration_seconds');
    });

    it('debería incrementar contador de solicitudes HTTP', () => {
      httpRequestsTotal.labels('GET', '/api/test', '200').inc();
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_http_requests_total');
    });
  });

  describe('Database Metrics', () => {
    it('debería registrar duración de consulta BD', () => {
      dbQueryDuration.labels('SELECT', 'Usuarios').observe(0.1);
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_db_query_duration_seconds');
    });

    it('debería establecer número de conexiones activas', () => {
      setDBConnections(5);
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_db_connections_active');
    });
  });

  describe('Cache Metrics', () => {
    it('debería incrementar hits de caché', () => {
      incrementCacheHit('blacklist');
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_cache_hits_total');
    });

    it('debería incrementar misses de caché', () => {
      incrementCacheMiss('blacklist');
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_cache_misses_total');
    });
  });

  describe('Helper Functions', () => {
    it('debería incrementar cache hit correctamente', () => {
      incrementCacheHit('blacklist');
      incrementCacheHit('blacklist');
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_cache_hits_total{cache_type="blacklist"} 2');
    });

    it('debería observar duración de consulta BD', () => {
      observeDBQuery('SELECT', 'Usuarios', 0.15, 'success');
      
      const metrics = register.metrics();
      expect(metrics).toContain('anpr_db_query_duration_seconds');
    });
  });
});