import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, roleMiddleware } from '../middlewares/auth';

const router = Router();

// GET /api/usuarios - Obtener lista de usuarios (Solo Admin)
router.get('/', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  try {
    const db = getDB();
    const result = await db.request()
      .query('SELECT id, username, nombre, rol, activo, created_at FROM Usuarios ORDER BY created_at DESC');
    return res.json(result.recordset);
  } catch (error: any) {
    console.error('[USUARIOS] Error al obtener usuarios:', error.message);
    return res.status(500).json({ error: 'Error al consultar la lista de usuarios.' });
  }
});

// POST /api/usuarios - Registrar nuevo usuario (Solo Admin)
router.post('/', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  const { username, password, nombre, rol } = req.body;

  if (!username || !password || !nombre || !rol) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios: username, password, nombre, rol.' });
  }

  if (rol !== 'Admin' && rol !== 'Operador') {
    return res.status(400).json({ error: 'El rol debe ser Admin u Operador.' });
  }

  try {
    const db = getDB();

    // Validar si el usuario ya existe
    const exists = await db.request()
      .input('username', sql.VarChar, username)
      .query('SELECT id FROM Usuarios WHERE username = @username');

    if (exists.recordset.length > 0) {
      return res.status(400).json({ error: 'El nombre de usuario ya está registrado.' });
    }

    // Encriptar contraseña
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.request()
      .input('username', sql.VarChar, username)
      .input('hash', sql.VarChar, passwordHash)
      .input('nombre', sql.VarChar, nombre)
      .input('rol', sql.VarChar, rol)
      .query(`
        INSERT INTO Usuarios (username, password_hash, nombre, rol, activo, created_at)
        OUTPUT inserted.id, inserted.username, inserted.nombre, inserted.rol, inserted.activo, inserted.created_at
        VALUES (@username, @hash, @nombre, @rol, 1, GETDATE())
      `);

    return res.status(201).json({
      message: 'Usuario registrado con éxito.',
      user: result.recordset[0]
    });
  } catch (error: any) {
    console.error('[USUARIOS] Error al registrar usuario:', error.message);
    return res.status(500).json({ error: 'Error al registrar el nuevo usuario.' });
  }
});

export default router;
