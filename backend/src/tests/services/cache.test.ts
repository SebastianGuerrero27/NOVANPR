/**
 * Tests para el servicio de caché
 */

import { cacheService, cacheHelper } from '../../services/cache';

// Mock de ioredis
jest.mock('ioredis', () => {
  const mockRedis = {
    on: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
    exists: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    mget: jest.fn(),
    mset: jest.fn(),
    flushall: jest.fn(),
    info: jest.fn(),
    quit: jest.fn(),
  };

  return {
    __esModule: true,
    default: jest.fn(() => mockRedis),
  };
});

describe('CacheService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isAvailable', () => {
    it('debería retornar false cuando Redis está deshabilitado', () => {
      process.env.ENABLE_REDIS_CACHE = 'false';
      const service = new (cacheService as any).constructor();
      expect(service.isAvailable()).toBe(false);
    });

    it('debería retornar true cuando Redis está disponible', () => {
      process.env.ENABLE_REDIS_CACHE = 'true';
      const service = new (cacheService as any).constructor();
      service.isConnected = true;
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('get', () => {
    it('debería retornar null cuando el caché no está disponible', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = false;
      
      const result = await service.get('test_key');
      expect(result).toBeNull();
    });

    it('debería parsear JSON correctamente', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = true;
      service.client = {
        get: jest.fn().mockResolvedValue('{"test": "value"}'),
      };

      const result = await service.get('test_key');
      expect(result).toEqual({ test: 'value' });
    });

    it('debería retornar null para valor vacío', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = true;
      service.client = {
        get: jest.fn().mockResolvedValue(null),
      };

      const result = await service.get('test_key');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('debería retornar false cuando el caché no está disponible', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = false;
      
      const result = await service.set('test_key', { test: 'value' });
      expect(result).toBe(false);
    });

    it('debería serializar JSON y guardar', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = true;
      service.client = {
        setex: jest.fn().mockResolvedValue('OK'),
      };

      const result = await service.set('test_key', { test: 'value' }, 300);
      expect(result).toBe(true);
      expect(service.client.setex).toHaveBeenCalledWith(
        'test_key',
        300,
        JSON.stringify({ test: 'value' })
      );
    });
  });

  describe('delete', () => {
    it('debería retornar false cuando el caché no está disponible', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = false;
      
      const result = await service.delete('test_key');
      expect(result).toBe(false);
    });

    it('debería eliminar la clave', async () => {
      const service = new (cacheService as any).constructor();
      service.isConnected = true;
      service.client = {
        del: jest.fn().mockResolvedValue(1),
      };

      const result = await service.delete('test_key');
      expect(result).toBe(true);
      expect(service.client.del).toHaveBeenCalledWith('test_key');
    });
  });
});

describe('CacheHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getSession', () => {
    it('debería obtener sesión del caché', async () => {
      const mockSession = { userId: 1, username: 'test' };
      jest.spyOn(cacheService, 'get').mockResolvedValue(mockSession);

      const result = await cacheHelper.getSession(1);
      expect(result).toEqual(mockSession);
      expect(cacheService.get).toHaveBeenCalledWith('session:1');
    });
  });

  describe('setSession', () => {
    it('debería guardar sesión en caché', async () => {
      const mockSession = { userId: 1, username: 'test' };
      jest.spyOn(cacheService, 'set').mockResolvedValue(true);

      const result = await cacheHelper.setSession(1, mockSession, 3600);
      expect(result).toBe(true);
      expect(cacheService.set).toHaveBeenCalledWith('session:1', mockSession, 3600);
    });
  });

  describe('getBlacklist', () => {
    it('debería obtener lista negra del caché', async () => {
      const mockBlacklist = [{ id: 1, placa: 'PBA-1234' }];
      jest.spyOn(cacheService, 'get').mockResolvedValue(mockBlacklist);

      const result = await cacheHelper.getBlacklist();
      expect(result).toEqual(mockBlacklist);
      expect(cacheService.get).toHaveBeenCalledWith('blacklist:all');
    });
  });

  describe('setBlacklist', () => {
    it('debería guardar lista negra en caché', async () => {
      const mockBlacklist = [{ id: 1, placa: 'PBA-1234' }];
      jest.spyOn(cacheService, 'set').mockResolvedValue(true);

      const result = await cacheHelper.setBlacklist(mockBlacklist, 300);
      expect(result).toBe(true);
      expect(cacheService.set).toHaveBeenCalledWith('blacklist:all', mockBlacklist, 300);
    });
  });

  describe('checkRateLimit', () => {
    it('debería permitir cuando no excede el límite', async () => {
      jest.spyOn(cacheService, 'incrementWithExpiry').mockResolvedValue(5);

      const result = await cacheHelper.checkRateLimit('user_123', 10, 60);
      expect(result).toBe(true);
    });

    it('debería denegar cuando excede el límite', async () => {
      jest.spyOn(cacheService, 'incrementWithExpiry').mockResolvedValue(15);

      const result = await cacheHelper.checkRateLimit('user_123', 10, 60);
      expect(result).toBe(false);
    });
  });
});