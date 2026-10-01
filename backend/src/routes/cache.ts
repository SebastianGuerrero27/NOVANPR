/**
 * Rutas de administración del caché Redis
 * Solo accesibles para administradores
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { cacheService, cacheHelper } from '../services/cache';

const router = Router();

// GET /api/cache/stats - Obtener estadísticas del caché
router.get('/stats', authMiddleware, requierePermiso('configuracion:gestionar'), async (req: Request, res: Response) => {
  try {
    const stats = await cacheService.getStats();
    return res.json({
      available: cacheService.isAvailable(),
      stats,
    });
  } catch (error: any) {
    console.error('[CACHE] Error obteniendo estadísticas:', error.message);
    return res.status(500).json({ error: 'Error al obtener estadísticas del caché.' });
  }
});

// DELETE /api/cache/flush - Limpiar todo el caché (con precaución)
router.delete('/flush', authMiddleware, requierePermiso('configuracion:gestionar'), async (req: Request, res: Response) => {
  try {
    const success = await cacheService.flushAll();
    if (success) {
      return res.json({ message: 'Caché limpiado exitosamente.' });
    } else {
      return res.status(500).json({ error: 'No se pudo limpiar el caché.' });
    }
  } catch (error: any) {
    console.error('[CACHE] Error limpiando caché:', error.message);
    return res.status(500).json({ error: 'Error al limpiar el caché.' });
  }
});

// DELETE /api/cache/blacklist - Invalidar caché de lista negra
router.delete('/blacklist', authMiddleware, requierePermiso('configuracion:gestionar'), async (req: Request, res: Response) => {
  try {
    const success = await cacheHelper.invalidateBlacklist();
    if (success) {
      return res.json({ message: 'Caché de lista negra invalidado.' });
    } else {
      return res.status(500).json({ error: 'No se pudo invalidar el caché de lista negra.' });
    }
  } catch (error: any) {
    console.error('[CACHE] Error invalidando caché de lista negra:', error.message);
    return res.status(500).json({ error: 'Error al invalidar caché de lista negra.' });
  }
});

// DELETE /api/cache/authorized - Invalidar caché de vehículos autorizados
router.delete('/authorized', authMiddleware, requierePermiso('configuracion:gestionar'), async (req: Request, res: Response) => {
  try {
    const success = await cacheHelper.invalidateAuthorizedVehicles();
    if (success) {
      return res.json({ message: 'Caché de vehículos autorizados invalidado.' });
    } else {
      return res.status(500).json({ error: 'No se pudo invalidar el caché de vehículos autorizados.' });
    }
  } catch (error: any) {
    console.error('[CACHE] Error invalidando caché de vehículos autorizados:', error.message);
    return res.status(500).json({ error: 'Error al invalidar caché de vehículos autorizados.' });
  }
});

// DELETE /api/cache/pattern/:pattern - Eliminar claves por patrón
router.delete('/pattern/:pattern', authMiddleware, requierePermiso('configuracion:gestionar'), async (req: Request, res: Response) => {
  try {
    const { pattern } = req.params;
    const count = await cacheService.deletePattern(pattern);
    return res.json({ message: `Eliminadas ${count} claves con patrón ${pattern}.` });
  } catch (error: any) {
    console.error('[CACHE] Error eliminando por patrón:', error.message);
    return res.status(500).json({ error: 'Error al eliminar claves por patrón.' });
  }
});

export default router;