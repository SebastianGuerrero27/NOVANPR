import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, roleMiddleware } from '../middlewares/auth';
import { cacheHelper } from '../services/cache';

const router = Router();

// GET /api/blacklist - Listar vehículos en lista negra (con caché)
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    // Intentar obtener del caché primero
    const cached = await cacheHelper.getBlacklist();
    if (cached) {
      return res.json(cached);
    }

    // Si no está en caché, consultar la base de datos
    const db = getDB();
    const result = await db.request()
      .query('SELECT * FROM ListaNegra WHERE activo = 1 ORDER BY fecha_registro DESC');
    
    const blacklist = result.recordset;
    
    // Guardar en caché por 5 minutos
    await cacheHelper.setBlacklist(blacklist, 300);
    
    return res.json(blacklist);
  } catch (error: any) {
    console.error('[BLACKLIST] Error al obtener lista negra:', error.message);
    return res.status(500).json({ error: 'Error al obtener registros de la lista negra.' });
  }
});

// POST /api/blacklist - Registrar vehículo en lista negra (Solo Admin)
router.post('/', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  const { placa, motivo, nivel_alerta } = req.body;

  if (!placa || !motivo) {
    return res.status(400).json({ error: 'La placa y el motivo son obligatorios.' });
  }

  // Normalizar placa a mayúsculas y quitar espacios/guiones
  const normalizedPlaca = placa.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');

  try {
    const db = getDB();

    // Validar si ya existe
    const exists = await db.request()
      .input('placa', sql.VarChar, normalizedPlaca)
      .query('SELECT id, activo FROM ListaNegra WHERE placa = @placa');

    if (exists.recordset.length > 0) {
      const existing = exists.recordset[0];
      if (existing.activo) {
        return res.status(400).json({ error: 'Este vehículo ya se encuentra registrado y activo en la lista negra.' });
      } else {
        // Reactivar si estaba inactivo
        const reactivate = await db.request()
          .input('id', sql.Int, existing.id)
          .input('motivo', sql.VarChar, motivo)
          .input('nivel', sql.VarChar, nivel_alerta || 'ALTA')
          .query(`
            UPDATE ListaNegra 
            SET activo = 1, motivo = @motivo, nivel_alerta = @nivel, fecha_registro = GETDATE()
            OUTPUT inserted.*
            WHERE id = @id
          `);
        return res.status(200).json({ message: 'Vehículo reactivado en lista negra.', item: reactivate.recordset[0] });
      }
    }

    const result = await db.request()
      .input('placa', sql.VarChar, normalizedPlaca)
      .input('motivo', sql.VarChar, motivo)
      .input('nivel', sql.VarChar, nivel_alerta || 'ALTA')
      .query(`
        INSERT INTO ListaNegra (placa, motivo, nivel_alerta, activo, fecha_registro)
        OUTPUT inserted.*
        VALUES (@placa, @motivo, @nivel, 1, GETDATE())
      `);

    // Invalidar caché de lista negra
    await cacheHelper.invalidateBlacklist();

    return res.status(201).json({ message: 'Vehículo agregado a la lista negra con éxito.', item: result.recordset[0] });
  } catch (error: any) {
    console.error('[BLACKLIST] Error al guardar en lista negra:', error.message);
    return res.status(500).json({ error: 'Error al registrar el vehículo en la lista negra.' });
  }
});

// DELETE /api/blacklist/:id - Eliminar o desactivar vehículo de la lista negra (Solo Admin)
router.delete('/:id', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const db = getDB();
    const result = await db.request()
      .input('id', sql.Int, parseInt(id))
      .query('UPDATE ListaNegra SET activo = 0 WHERE id = @id');

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Registro de lista negra no encontrado.' });
    }

    // Invalidar caché de lista negra
    await cacheHelper.invalidateBlacklist();

    return res.json({ message: 'Vehículo eliminado de la lista negra con éxito.' });
  } catch (error: any) {
    console.error('[BLACKLIST] Error al eliminar de lista negra:', error.message);
    return res.status(500).json({ error: 'Error al retirar el vehículo de la lista negra.' });
  }
});

export default router;
