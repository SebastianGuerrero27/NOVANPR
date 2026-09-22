/**
 * Ruta: /api/vehiculos-autorizados
 *
 * CRUD para la whitelist institucional de vehículos autorizados.
 * - GET: cualquier usuario autenticado puede consultar.
 * - POST/DELETE: solo rol Admin.
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, roleMiddleware } from '../middlewares/auth';
import { cacheHelper } from '../services/cache';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehiculos-autorizados — Listar vehículos autorizados activos (con caché)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    // Intentar obtener del caché primero
    const cached = await cacheHelper.getAuthorizedVehicles();
    if (cached) {
      return res.json(cached);
    }

    // Si no está en caché, consultar la base de datos
    const db = getDB();
    const result = await db.request()
      .query('SELECT * FROM VehiculosAutorizados WHERE activo = 1 ORDER BY fecha_registro DESC');
    
    const vehicles = result.recordset;
    
    // Guardar en caché por 5 minutos
    await cacheHelper.setAuthorizedVehicles(vehicles, 300);
    
    return res.json(vehicles);
  } catch (error: any) {
    console.error('[WHITELIST] Error al obtener vehículos autorizados:', error.message);
    return res.status(500).json({ error: 'Error al consultar la lista de vehículos autorizados.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehiculos-autorizados — Registrar vehículo autorizado (Solo Admin)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  const { placa, propietario, departamento, tipo_vehiculo } = req.body;

  if (!placa || !propietario) {
    return res.status(400).json({ error: 'La placa y el propietario son obligatorios.' });
  }

  // Normalizar placa
  const normalizedPlaca = placa.toUpperCase().trim().replace(/[^A-Z0-9]/g, '');

  try {
    const db = getDB();

    // Verificar si ya existe
    const exists = await db.request()
      .input('placa', sql.VarChar, normalizedPlaca)
      .query('SELECT id, activo FROM VehiculosAutorizados WHERE placa = @placa');

    if (exists.recordset.length > 0) {
      const existing = exists.recordset[0];
      if (existing.activo) {
        return res.status(400).json({ error: 'Este vehículo ya está registrado como autorizado.' });
      } else {
        // Reactivar si estaba inactivo
        const reactivate = await db.request()
          .input('id', sql.Int, existing.id)
          .input('propietario', sql.VarChar, propietario)
          .input('departamento', sql.VarChar, departamento || null)
          .input('tipo', sql.VarChar, tipo_vehiculo || null)
          .query(`
            UPDATE VehiculosAutorizados
            SET activo = 1, propietario = @propietario, departamento = @departamento,
                tipo_vehiculo = @tipo, fecha_registro = GETDATE()
            OUTPUT inserted.*
            WHERE id = @id
          `);
        // Invalidar caché de vehículos autorizados
        await cacheHelper.invalidateAuthorizedVehicles();

        return res.status(200).json({
          message: 'Vehículo reactivado en la lista de autorizados.',
          vehiculo: reactivate.recordset[0]
        });
      }
    }

    // Insertar nuevo
    const result = await db.request()
      .input('placa', sql.VarChar, normalizedPlaca)
      .input('propietario', sql.VarChar, propietario)
      .input('departamento', sql.VarChar, departamento || null)
      .input('tipo', sql.VarChar, tipo_vehiculo || null)
      .query(`
        INSERT INTO VehiculosAutorizados (placa, propietario, departamento, tipo_vehiculo, activo, fecha_registro)
        OUTPUT inserted.*
        VALUES (@placa, @propietario, @departamento, @tipo, 1, GETDATE())
      `);

    // Invalidar caché de vehículos autorizados
    await cacheHelper.invalidateAuthorizedVehicles();

    return res.status(201).json({
      message: 'Vehículo registrado como autorizado exitosamente.',
      vehiculo: result.recordset[0]
    });
  } catch (error: any) {
    console.error('[WHITELIST] Error al registrar vehículo autorizado:', error.message);
    return res.status(500).json({ error: 'Error al registrar el vehículo autorizado.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vehiculos-autorizados/:id — Desactivar vehículo (Solo Admin)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, roleMiddleware(['Admin']), async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const db = getDB();
    const result = await db.request()
      .input('id', sql.Int, parseInt(id))
      .query('UPDATE VehiculosAutorizados SET activo = 0 WHERE id = @id');

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Vehículo autorizado no encontrado.' });
    }

    // Invalidar caché de vehículos autorizados
    await cacheHelper.invalidateAuthorizedVehicles();

    return res.json({ message: 'Vehículo retirado de la lista de autorizados.' });
  } catch (error: any) {
    console.error('[WHITELIST] Error al desactivar vehículo autorizado:', error.message);
    return res.status(500).json({ error: 'Error al retirar el vehículo de la lista de autorizados.' });
  }
});

export default router;
