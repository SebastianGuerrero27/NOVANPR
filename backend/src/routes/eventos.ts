import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware } from '../middlewares/auth';
import { emitEvent } from '../services/socket';

const router = Router();

// GET /api/eventos - Listar eventos de ingreso con filtros
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const { placa, fechaInicio, fechaFin, camaraId } = req.query;

  try {
    const db = getDB();
    let queryStr = `
      SELECT e.*, c.nombre as camara_nombre, c.ubicacion as camara_ubicacion,
             u.nombre as validador_nombre, l.motivo as alerta_motivo, l.nivel_alerta
      FROM EventosIngreso e
      LEFT JOIN Camaras c ON e.camara_id = c.id
      LEFT JOIN Usuarios u ON e.usuario_validador_id = u.id
      LEFT JOIN ListaNegra l ON e.alerta_id = l.id
      WHERE 1=1
    `;

    const request = db.request();

    if (placa) {
      request.input('placa', sql.VarChar, `%${placa}%`);
      queryStr += ` AND e.placa LIKE @placa`;
    }

    if (fechaInicio) {
      request.input('fechaInicio', sql.DateTime, new Date(fechaInicio as string));
      queryStr += ` AND e.fecha_hora >= @fechaInicio`;
    }

    if (fechaFin) {
      request.input('fechaFin', sql.DateTime, new Date(fechaFin as string));
      queryStr += ` AND e.fecha_hora <= @fechaFin`;
    }

    if (camaraId) {
      request.input('camaraId', sql.Int, parseInt(camaraId as string));
      queryStr += ` AND e.camara_id = @camaraId`;
    }

    queryStr += ` ORDER BY e.fecha_hora DESC`;

    const result = await request.query(queryStr);
    return res.json(result.recordset);
  } catch (error: any) {
    console.error('[EVENTOS] Error al consultar eventos:', error.message);
    return res.status(500).json({ error: 'Error al consultar el historial de eventos.' });
  }
});

// POST /api/eventos/sync - Recepción desde el microservicio ANPR (Interno)
router.post('/sync', async (req: Request, res: Response) => {
  const { placa, confianza_placa, imagen_vehiculo_path, imagen_placa_path, camara_id } = req.body;

  if (!placa || confianza_placa === undefined || !camara_id) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos: placa, confianza_placa, camara_id.' });
  }

  try {
    const db = getDB();
    
    // 1. Verificar si la cámara existe
    const camaraCheck = await db.request()
      .input('camaraId', sql.Int, camara_id)
      .query('SELECT nombre, ubicacion FROM Camaras WHERE id = @camaraId');
    
    if (camaraCheck.recordset.length === 0) {
      return res.status(404).json({ error: 'La cámara especificada no existe.' });
    }
    const camara = camaraCheck.recordset[0];

    // 2. Verificar si la placa está en la Lista Negra activa
    const blacklistCheck = await db.request()
      .input('placa', sql.VarChar, placa)
      .query('SELECT * FROM ListaNegra WHERE placa = @placa AND activo = 1');

    let alerta_detectada = 0;
    let alerta_id = null;
    let alerta_info = null;

    if (blacklistCheck.recordset.length > 0) {
      alerta_detectada = 1;
      alerta_id = blacklistCheck.recordset[0].id;
      alerta_info = blacklistCheck.recordset[0];
    }

    // 3. Insertar el evento en SQL Server
    const insertResult = await db.request()
      .input('placa', sql.VarChar, placa)
      .input('confianza', sql.Float, confianza_placa)
      .input('imgVehiculo', sql.VarChar, imagen_vehiculo_path || '')
      .input('imgPlaca', sql.VarChar, imagen_placa_path || '')
      .input('camaraId', sql.Int, camara_id)
      .input('alertaDetectada', sql.Bit, alerta_detectada)
      .input('alertaId', sql.Int, alerta_id)
      .query(`
        INSERT INTO EventosIngreso 
        (placa, confianza_placa, imagen_vehiculo_path, imagen_placa_path, fecha_hora, camara_id, alerta_detectada, alerta_id, validado_manualmente)
        OUTPUT inserted.*
        VALUES 
        (@placa, @confianza, @imgVehiculo, @imgPlaca, GETDATE(), @camaraId, @alertaDetectada, @alertaId, 0)
      `);

    const nuevoEvento = insertResult.recordset[0];
    
    // Formatear evento para el frontend
    const eventoCompleto = {
      ...nuevoEvento,
      camara_nombre: camara.nombre,
      camara_ubicacion: camara.ubicacion,
      alerta_motivo: alerta_info ? alerta_info.motivo : null,
      nivel_alerta: alerta_info ? alerta_info.nivel_alerta : null
    };

    // 4. Emitir notificaciones en tiempo real por WebSocket
    emitEvent('nuevo_evento', eventoCompleto);

    if (alerta_detectada === 1) {
      console.log(`[ALERTA] ¡Vehículo sospechoso detectado! Placa: ${placa}`);
      emitEvent('nueva_alerta', eventoCompleto);
    }

    return res.status(201).json({ 
      message: 'Evento sincronizado exitosamente.', 
      evento: eventoCompleto 
    });
  } catch (error: any) {
    console.error('[SYNC] Error al sincronizar detección ANPR:', error.message);
    return res.status(500).json({ error: 'Error interno al procesar el evento de ingreso.' });
  }
});

// GET /api/reportes/exportar - Exportar registros de ingreso a CSV
router.get('/exportar', authMiddleware, async (req: Request, res: Response) => {
  const { placa, fechaInicio, fechaFin, camaraId } = req.query;

  try {
    const db = getDB();
    let queryStr = `
      SELECT e.id, e.placa, e.confianza_placa, e.fecha_hora, 
             c.nombre as camara_nombre, e.alerta_detectada, l.motivo as alerta_motivo,
             e.validado_manualmente, e.placa_validada, u.username as validador_usuario
      FROM EventosIngreso e
      LEFT JOIN Camaras c ON e.camara_id = c.id
      LEFT JOIN Usuarios u ON e.usuario_validador_id = u.id
      LEFT JOIN ListaNegra l ON e.alerta_id = l.id
      WHERE 1=1
    `;

    const request = db.request();

    if (placa) {
      request.input('placa', sql.VarChar, `%${placa}%`);
      queryStr += ` AND e.placa LIKE @placa`;
    }

    if (fechaInicio) {
      request.input('fechaInicio', sql.DateTime, new Date(fechaInicio as string));
      queryStr += ` AND e.fecha_hora >= @fechaInicio`;
    }

    if (fechaFin) {
      request.input('fechaFin', sql.DateTime, new Date(fechaFin as string));
      queryStr += ` AND e.fecha_hora <= @fechaFin`;
    }

    if (camaraId) {
      request.input('camaraId', sql.Int, parseInt(camaraId as string));
      queryStr += ` AND e.camara_id = @camaraId`;
    }

    queryStr += ` ORDER BY e.fecha_hora DESC`;

    const result = await request.query(queryStr);
    const records = result.recordset;

    // Generar formato CSV
    let csvContent = 'ID,Placa,Confianza,Fecha/Hora,Camara,Alerta Detectada,Motivo Alerta,Validado Manualmente,Placa Validada,Usuario Validador\n';
    
    for (const record of records) {
      const id = record.id;
      const placaStr = record.placa;
      const confianza = record.confianza_placa;
      const fecha = new Date(record.fecha_hora).toISOString();
      const camara = record.camara_nombre || 'N/A';
      const alerta = record.alerta_detectada ? 'SI' : 'NO';
      const motivo = record.alerta_motivo ? `"${record.alerta_motivo.replace(/"/g, '""')}"` : '';
      const validado = record.validado_manualmente ? 'SI' : 'NO';
      const placaVal = record.placa_validada || '';
      const userVal = record.validador_usuario || '';

      csvContent += `${id},${placaStr},${confianza},${fecha},${camara},${alerta},${motivo},${validado},${placaVal},${userVal}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=reporte-ingresos.csv');
    return res.status(200).send(csvContent);

  } catch (error: any) {
    console.error('[REPORTES] Error al exportar CSV:', error.message);
    return res.status(500).json({ error: 'Error al generar el reporte CSV.' });
  }
});

// POST /api/eventos/validar/:id - Validación manual de un operador
router.post('/validar/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { placa_validada } = req.body;

  if (!placa_validada) {
    return res.status(400).json({ error: 'Debe ingresar la placa validada manualmente.' });
  }

  try {
    const db = getDB();
    const result = await db.request()
      .input('id', sql.Int, parseInt(id))
      .input('placaValidada', sql.VarChar, placa_validada)
      .input('userId', sql.Int, req.user?.id)
      .query(`
        UPDATE EventosIngreso 
        SET validado_manualmente = 1, placa_validada = @placaValidada, usuario_validador_id = @userId
        OUTPUT inserted.*
        WHERE id = @id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Evento de ingreso no encontrado.' });
    }

    // Emitir el evento de actualización a todos los operadores
    emitEvent('evento_validado', result.recordset[0]);

    return res.json({ message: 'Evento validado manualmente de forma exitosa.', evento: result.recordset[0] });
  } catch (error: any) {
    console.error('[EVENTOS] Error en validación manual:', error.message);
    return res.status(500).json({ error: 'Error al registrar la validación manual.' });
  }
});

export default router;
