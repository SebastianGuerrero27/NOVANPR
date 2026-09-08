import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware } from '../middlewares/auth';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'ecu911_super_secret_token_key_2026';

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
  }

  try {
    const db = getDB();
    const result = await db.request()
      .input('username', sql.VarChar, username)
      .query('SELECT * FROM Usuarios WHERE username = @username AND activo = 1');

    const user = result.recordset[0];
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        nombre: user.nombre,
        rol: user.rol
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        nombre: user.nombre,
        rol: user.rol
      }
    });
  } catch (error: any) {
    console.error('[AUTH] Error en login:', error.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  return res.json({ user: req.user });
});

export default router;
