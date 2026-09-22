/**
 * Tests para endpoints de autenticación
 */

import request from 'supertest';
import express from 'express';
import authRoutes from '../../routes/auth';

// Mock de la base de datos
jest.mock('../../config/db', () => ({
  getDB: jest.fn(() => ({
    request: jest.fn(() => ({
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          {
            id: 1,
            username: 'admin',
            password_hash: '$2a$10$test_hash',
            nombre: 'Admin User',
            rol: 'Admin',
            activo: 1,
          },
        ],
      }),
    })),
  })),
}));

// Mock de JWT
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'test_token'),
}));

describe('Auth API', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
  });

  describe('POST /api/auth/login', () => {
    it('debería iniciar sesión exitosamente con credenciales válidas', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'admin',
          password: 'PasswordAdmin123!',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
    });

    it('debería rechazar credenciales inválidas', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'admin',
          password: 'wrong_password',
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    it('debería requerir username y password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          username: 'admin',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });
});