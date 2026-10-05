/**
 * Configuración global para tests
 */

// Mock de variables de entorno
process.env.NODE_ENV = 'test';
process.env.PORT = '5000';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.DB_SERVER = 'localhost';
process.env.DB_PORT = '1433';
process.env.DB_NAME = 'ANPR_ECU911_TEST';
process.env.JWT_SECRET = 'test_secret_key';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';

// Mock de logger para no ensuciar la salida
jest.mock('../infraestructura/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));