/**
 * Servicio de Caché Distribuido con Redis
 * 
 * Este servicio proporciona una capa de caché distribuido para:
 * - Sesiones de usuarios
 * - Estado compartido entre instancias
 * - Caché de consultas frecuentes
 * - Rate limiting
 * - Cache de datos de listas negras/blancas
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger';

interface CacheConfig {
  host: string;
  port: number;
  password?: string;
  ttl?: number;
  enabled: boolean;
}

class CacheService {
  private client: Redis | null = null;
  private config: CacheConfig;
  private isConnected: boolean = false;

  constructor() {
    this.config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      ttl: parseInt(process.env.CACHE_TTL_SECONDS || '3600'),
      enabled: process.env.ENABLE_REDIS_CACHE === 'true',
    };

    if (this.config.enabled) {
      this.connect();
    } else {
      logger.info('Redis cache deshabilitado por configuración');
    }
  }

  private async connect(): Promise<void> {
    try {
      this.client = new Redis({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          logger.warn(`Reintentando conexión Redis en ${delay}ms (intento ${times})`);
          return delay;
        },
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        logger.info('Conectado a Redis exitosamente');
      });

      this.client.on('error', (error) => {
        this.isConnected = false;
        logger.error('Error en conexión Redis:', error);
      });

      this.client.on('close', () => {
        this.isConnected = false;
        logger.warn('Conexión Redis cerrada');
      });

      // Probar conexión
      await this.client.ping();
      logger.info('Ping a Redis exitoso');
    } catch (error) {
      this.isConnected = false;
      logger.error('Error conectando a Redis:', error);
      this.client = null;
    }
  }

  /**
   * Verifica si el servicio está disponible
   */
  public isAvailable(): boolean {
    return this.config.enabled && this.isConnected && this.client !== null;
  }

  /**
   * Obtiene un valor del caché
   */
  public async get<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const value = await this.client!.get(key);
      if (value === null) {
        return null;
      }
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error(`Error obteniendo clave ${key} del caché:`, error);
      return null;
    }
  }

  /**
   * Guarda un valor en el caché
   */
  public async set(key: string, value: any, ttl?: number): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const serialized = JSON.stringify(value);
      const expiry = ttl || this.config.ttl || 3600;
      await this.client!.setex(key, expiry, serialized);
      return true;
    } catch (error) {
      logger.error(`Error guardando clave ${key} en caché:`, error);
      return false;
    }
  }

  /**
   * Elimina una clave del caché
   */
  public async delete(key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client!.del(key);
      return true;
    } catch (error) {
      logger.error(`Error eliminando clave ${key} del caché:`, error);
      return false;
    }
  }

  /**
   * Elimina múltiples claves por patrón
   */
  public async deletePattern(pattern: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const keys = await this.client!.keys(pattern);
      if (keys.length === 0) {
        return 0;
      }
      await this.client!.del(...keys);
      return keys.length;
    } catch (error) {
      logger.error(`Error eliminando patrón ${pattern} del caché:`, error);
      return 0;
    }
  }

  /**
   * Verifica si una clave existe
   */
  public async exists(key: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const result = await this.client!.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Error verificando existencia de clave ${key}:`, error);
      return false;
    }
  }

  /**
   * Establece una clave con expiración solo si no existe
   */
  public async setNX(key: string, value: any, ttl?: number): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const serialized = JSON.stringify(value);
      const result = await this.client!.set(key, serialized, 'EX', ttl || this.config.ttl || 3600, 'NX');
      return result === 'OK';
    } catch (error) {
      logger.error(`Error en setNX para clave ${key}:`, error);
      return false;
    }
  }

  /**
   * Incrementa un contador
   */
  public async increment(key: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      return await this.client!.incr(key);
    } catch (error) {
      logger.error(`Error incrementando clave ${key}:`, error);
      return 0;
    }
  }

  /**
   * Incrementa un contador con expiración
   */
  public async incrementWithExpiry(key: string, expiry: number): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const value = await this.client!.incr(key);
      if (value === 1) {
        await this.client!.expire(key, expiry);
      }
      return value;
    } catch (error) {
      logger.error(`Error incrementando con expiración clave ${key}:`, error);
      return 0;
    }
  }

  /**
   * Obtiene múltiples claves
   */
  public async mget<T>(keys: string[]): Promise<(T | null)[]> {
    if (!this.isAvailable() || keys.length === 0) {
      return keys.map(() => null);
    }

    try {
      const values = await this.client!.mget(...keys);
      return values.map((value) => {
        if (value === null) return null;
        try {
          return JSON.parse(value) as T;
        } catch {
          return null;
        }
      });
    } catch (error) {
      logger.error('Error en mget:', error);
      return keys.map(() => null);
    }
  }

  /**
   * Guarda múltiples claves
   */
  public async mset(keyValuePairs: Record<string, any>, ttl?: number): Promise<boolean> {
    if (!this.isAvailable() || Object.keys(keyValuePairs).length === 0) {
      return false;
    }

    try {
      const pipeline = this.client!.pipeline();
      const expiry = ttl || this.config.ttl || 3600;

      for (const [key, value] of Object.entries(keyValuePairs)) {
        const serialized = JSON.stringify(value);
        pipeline.setex(key, expiry, serialized);
      }

      await pipeline.exec();
      return true;
    } catch (error) {
      logger.error('Error en mset:', error);
      return false;
    }
  }

  /**
   * Limpia todo el caché (con precaución)
   */
  public async flushAll(): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.client!.flushall();
      logger.warn('Caché Redis limpiado completamente');
      return true;
    } catch (error) {
      logger.error('Error limpiando caché:', error);
      return false;
    }
  }

  /**
   * Obtiene estadísticas del caché
   */
  public async getStats(): Promise<any> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const info = await this.client!.info('stats');
      const keyspace = await this.client!.info('keyspace');
      
      return {
        connected: this.isConnected,
        stats: info,
        keyspace: keyspace,
      };
    } catch (error) {
      logger.error('Error obteniendo estadísticas:', error);
      return null;
    }
  }

  /**
   * Cierra la conexión
   */
  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
      logger.info('Conexión Redis cerrada');
    }
  }
}

// Instancia singleton
export const cacheService = new CacheService();

// Funciones helper para casos de uso comunes
export const cacheHelper = {
  /**
   * Caché de sesiones de usuarios
   */
  async getSession(userId: number): Promise<any | null> {
    return cacheService.get(`session:${userId}`);
  },

  async setSession(userId: number, sessionData: any, ttl: number = 3600): Promise<boolean> {
    return cacheService.set(`session:${userId}`, sessionData, ttl);
  },

  async deleteSession(userId: number): Promise<boolean> {
    return cacheService.delete(`session:${userId}`);
  },

  /**
   * Caché de lista negra
   */
  async getBlacklist(): Promise<any[] | null> {
    return cacheService.get('blacklist:all');
  },

  async setBlacklist(blacklist: any[], ttl: number = 300): Promise<boolean> {
    return cacheService.set('blacklist:all', blacklist, ttl);
  },

  async invalidateBlacklist(): Promise<boolean> {
    return cacheService.delete('blacklist:all');
  },

  /**
   * Caché de vehículos autorizados
   */
  async getAuthorizedVehicles(): Promise<any[] | null> {
    return cacheService.get('authorized:all');
  },

  async setAuthorizedVehicles(vehicles: any[], ttl: number = 300): Promise<boolean> {
    return cacheService.set('authorized:all', vehicles, ttl);
  },

  async invalidateAuthorizedVehicles(): Promise<boolean> {
    return cacheService.delete('authorized:all');
  },

  /**
   * Rate limiting
   */
  async checkRateLimit(identifier: string, limit: number, window: number = 60): Promise<boolean> {
    const key = `ratelimit:${identifier}`;
    const current = await cacheService.incrementWithExpiry(key, window);
    return current <= limit;
  },

  /**
   * Cache de detecciones recientes
   */
  async getRecentDetections(limit: number = 100): Promise<any[] | null> {
    return cacheService.get(`detections:recent:${limit}`);
  },

  async setRecentDetections(detections: any[], limit: number = 100, ttl: number = 60): Promise<boolean> {
    return cacheService.set(`detections:recent:${limit}`, detections, ttl);
  },
};