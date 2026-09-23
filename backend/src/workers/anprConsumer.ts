/**
 * Worker Asíncrono de Ingesta y Consumo de Eventos ANPR (Node.js + TypeScript).
 * Arquitectura Desacoplada: Redis Streams / RabbitMQ -> SQL Server -> Socket.io.
 * Diseñado para ECU 911 Zona 3 (Ecuador).
 */

import { Server as SocketIOServer } from 'socket.io';
import sql from 'mssql';
import { getDB } from '../config/db';
import { findBlacklistMatch } from '../services/plateMatching';

export interface AnprStreamPayload {
  event_id: string;
  track_id: number;
  camara_id: number;
  placa: string;
  is_valid_ant: boolean;
  confianza: number;
  tipo_vehiculo: string;
  provincia: string;
  servicio: string;
  total_frames: number;
  ruta_imagen_placa: string;
  ruta_imagen_ingreso: string;
  latencia_ms: number;
  timestamp: number;
}

export class AnprEventConsumer {
  private isRunning: boolean = false;
  private io: SocketIOServer;
  private streamName: string = 'anpr:events:ecu911';

  constructor(io: SocketIOServer) {
    this.io = io;
  }

  /**
   * Procesa un evento consolidado recibido desde el microservicio de IA en Python.
   */
  public async handleConsolidatedEvent(event: AnprStreamPayload): Promise<void> {
    try {
      const pool = getDB();
      const placaLimpia = event.placa.replace(/[^A-Z0-9]/g, '');

      // 1. Verificación en SQL Server: Lista Negra (Alertas Críticas ECU 911 / Policía Nacional)
      //    Coincidencia tolerante a errores de OCR (exacta o aproximada).
      const matchLN = await findBlacklistMatch(pool, placaLimpia);

      const estaEnListaNegra = matchLN !== null;
      const alertaData = matchLN ? { ...matchLN.row, coincidencia: matchLN.coincidencia } : null;

      // 2. Verificación en SQL Server: Lista Blanca (Vehículos Autorizados Institucionales)
      const queryListaBlanca = `
        SELECT TOP 1 id, placa, propietario, departamento, tipo_vehiculo
        FROM VehiculosAutorizados
        WHERE REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa AND activo = 1
      `;
      const resultLB = await pool.request()
        .input('placa', sql.VarChar(20), placaLimpia)
        .query(queryListaBlanca);

      const estaEnListaBlanca = resultLB.recordset.length > 0;
      const autorizadoData = estaEnListaBlanca ? resultLB.recordset[0] : null;

      // 3. Determinación de Estado Operativo
      let estadoProcesamiento = 'PROCESADO';
      if (estaEnListaNegra) {
        estadoProcesamiento = 'ALERTA_LISTA_NEGRA';
      } else if (estaEnListaBlanca) {
        estadoProcesamiento = 'AUTORIZADO';
      } else if (!event.is_valid_ant || placaLimpia.length < 5) {
        estadoProcesamiento = 'NO_LEGIBLE';
      }

      // 4. Inserción Transaccional en Base de Datos (Tabla Detecciones)
      const insertQuery = `
        INSERT INTO Detecciones (
          camara_id,
          placa_detectada,
          confianza_deteccion,
          confianza_ocr,
          ruta_imagen_vehiculo,
          ruta_imagen_placa,
          estado,
          motivo_alerta,
          fecha_hora,
          tipo_vehiculo,
          provincia_emision
        )
        OUTPUT INSERTED.id
        VALUES (
          @camaraId,
          @placa,
          @confianzaDet,
          @confianzaOcr,
          @rutaVehiculo,
          @rutaPlaca,
          @estado,
          @motivoAlerta,
          GETDATE(),
          @tipoVehiculo,
          @provincia
        )
      `;

      const insertResult = await pool.request()
        .input('camaraId', sql.Int, event.camara_id || 1)
        .input('placa', sql.VarChar(20), event.placa)
        .input('confianzaDet', sql.Decimal(5, 2), 95.0)
        .input('confianzaOcr', sql.Decimal(5, 2), event.confianza * 100)
        .input('rutaVehiculo', sql.VarChar(500), event.ruta_imagen_ingreso)
        .input('rutaPlaca', sql.VarChar(500), event.ruta_imagen_placa)
        .input('estado', sql.VarChar(50), estadoProcesamiento)
        .input('motivoAlerta', sql.VarChar(500), alertaData ? alertaData.motivo : null)
        .input('tipoVehiculo', sql.VarChar(100), event.tipo_vehiculo)
        .input('provincia', sql.VarChar(100), event.provincia)
        .query(insertQuery);

      const nuevoId = insertResult.recordset[0].id;

      // 5. Emisión de Notificación en Tiempo Real vía WebSocket (Socket.io)
      const payloadWebSocket = {
        id: nuevoId,
        placa: event.placa,
        placa_reconocida: event.placa,
        confianza: event.confianza,
        confianza_ocr: event.confianza * 100,
        estado: estadoProcesamiento,
        is_lista_negra: estaEnListaNegra,
        is_lista_blanca: estaEnListaBlanca,
        motivo_alerta: alertaData ? alertaData.motivo : null,
        propietario: autorizadoData ? autorizadoData.propietario : null,
        departamento: autorizadoData ? autorizadoData.departamento : null,
        provincia: event.provincia,
        servicio: event.servicio,
        tipo_vehiculo: event.tipo_vehiculo,
        ruta_imagen_ingreso: event.ruta_imagen_ingreso,
        ruta_imagen_placa: event.ruta_imagen_placa,
        latencia_ms: event.latencia_ms,
        fecha_hora: new Date().toISOString(),
      };

      this.io.emit('nueva_deteccion', payloadWebSocket);

      // Alerta prioritaria si está en Lista Negra
      if (estaEnListaNegra) {
        this.io.emit('alerta_lista_negra', {
          ...payloadWebSocket,
          nivel_alerta: alertaData.nivel_alerta || 'CRITICA',
          mensaje: `¡VEHÍCULO CON ENCARGO / ALERTA POLICIAL DETECTADO: ${event.placa}!`,
        });
      }

      console.log(`[ANPR CONSUMER] Evento #${nuevoId} procesado | Placa: ${event.placa} | Estado: ${estadoProcesamiento} | Latencia: ${event.latencia_ms}ms`);

    } catch (error) {
      console.error('[ANPR CONSUMER] Error al procesar evento consolidado:', error);
    }
  }
}
