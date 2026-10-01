import sql from 'mssql';
import { getDB } from '../config/db';
import { describirHorario } from '../dominio/horario';
import { Decision, MOTIVO_RESTRICCION } from '../dominio/decisionAcceso';
import { severidadDeNivel } from '../dominio/notificaciones';
import { config } from './configuracion';
import { notificar } from './notificaciones';

/**
 * Traduce la decisión de un paso vehicular en notificaciones para el personal:
 *
 *   alerta                       → acceso.alerta_seguridad   (avisos:seguridad, prioridad según nivel)
 *   no_reconocido + restricción  → acceso.restringido        (avisos:acceso: garita y gestor de accesos)
 *   no_reconocido                → acceso.no_registrado      (avisos:acceso) + reincidencia al gestor
 *   pendiente por vehículo (R4)  → acceso.vehiculo_no_coincide
 *   pendiente por lectura (R3/R6)→ acceso.confirmacion       (avisos:garita)
 *   autorizado                   → sin notificación (el aviso verde efímero ya lo cubre)
 */

export interface PasoNotificable {
  id: number;
  placa: string | null;
  fecha_hora_ingreso: string | Date;
  camara: { nombre: string; ubicacion: string } | null;
  alerta: { motivo: string; nivel: string } | null;
  autorizado: { propietario: string } | null;
  verificacion_detalle?: string | null;
}

export interface ContextoPermiso {
  horario?: string | null;
  fecha_inicio?: Date | string | null;
  fecha_vencimiento?: Date | string | null;
}

const lugar = (d: PasoNotificable) => (d.camara ? `${d.camara.nombre} (${d.camara.ubicacion})` : 'Acceso vehicular');
const fechaCorta = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '');

export async function notificarDecision(d: PasoNotificable, decision: Decision, permiso?: ContextoPermiso | null): Promise<void> {
  const placa = d.placa ?? 'sin lectura';
  const base = {
    enlace: `/detecciones/${d.id}`,
    deteccionId: d.id,
    origen: new Date(d.fecha_hora_ingreso),
    datos: { deteccion_id: d.id, placa: d.placa, regla: decision.regla },
  };

  switch (decision.estado) {
    case 'alerta':
      await notificar({
        ...base, tipo: 'acceso.alerta_seguridad', severidad: severidadDeNivel(d.alerta?.nivel),
        titulo: `Alerta${d.alerta?.nivel ? ` ${d.alerta.nivel}` : ''} · ${placa}`,
        mensaje: `${d.alerta?.motivo ?? 'Placa en la lista de alertas'} · ${lugar(d)}`,
        claveDedup: `alerta:${placa}`,
      });
      return;

    case 'no_reconocido':
      if (decision.restriccion) {
        const detalle = decision.restriccion === 'fuera_horario'
          ? `Horario autorizado: ${describirHorario(permiso?.horario)}`
          : decision.restriccion === 'no_iniciada'
            ? `Vigente desde ${fechaCorta(permiso?.fecha_inicio)}`
            : `Venció el ${fechaCorta(permiso?.fecha_vencimiento)}`;
        await notificar({
          ...base, tipo: 'acceso.restringido',
          titulo: `${MOTIVO_RESTRICCION[decision.restriccion]} · ${placa}`,
          mensaje: `${d.autorizado?.propietario ?? 'Padrón'} · ${detalle} · ${lugar(d)}`,
          claveDedup: `restringido:${placa}`,
          datos: { ...base.datos, restriccion: decision.restriccion },
        });
        return;
      }
      await notificar({
        ...base, tipo: 'acceso.no_registrado',
        titulo: `Vehículo sin permiso · ${placa}`,
        mensaje: `No consta en el padrón de autorizados · ${lugar(d)}`,
        claveDedup: `no_registrado:${placa}`,
      });
      if (d.placa) await revisarReincidencia(d.placa);
      return;

    case 'pendiente_revision':
      if (decision.regla === 'R4') {
        await notificar({
          ...base, tipo: 'acceso.vehiculo_no_coincide',
          titulo: `Vehículo distinto al registrado · ${placa}`,
          mensaje: `${d.verificacion_detalle ?? 'Marca, color o tipo no coinciden'}: posible placa clonada o lectura errónea · ${lugar(d)}`,
          claveDedup: `vehiculo:${placa}`,
        });
        return;
      }
      await notificar({
        ...base, tipo: 'acceso.confirmacion',
        titulo: `Confirme el ingreso · ${placa}`,
        mensaje: `${decision.motivos.join('; ')} · ${lugar(d)}`,
        claveDedup: `confirmacion:${placa}`,
      });
      return;

    default:
      return;
  }
}

/**
 * Una placa sin permiso que insiste (≥ umbral intentos en 24 h) se reporta al gestor de
 * accesos una vez al día: o es un vehículo legítimo que falta registrar o un caso a investigar.
 */
async function revisarReincidencia(placa: string): Promise<void> {
  try {
    const umbral = config.entero('notif_reincidencia_umbral');
    const r = await getDB().request().input('placa', sql.VarChar(20), placa).query(`
      SELECT COUNT(*) AS n FROM DeteccionVehiculo
      WHERE estado_validacion = 'no_reconocido' AND restriccion_acceso IS NULL
        AND REPLACE(COALESCE(placa_validada, placa_reconocida, ''), '-', '') = @placa
        AND fecha_hora_ingreso >= DATEADD(HOUR, -24, GETDATE())`);
    const n = Number(r.recordset[0]?.n ?? 0);
    if (n < umbral) return;
    await notificar({
      tipo: 'acceso.reincidencia',
      titulo: `${placa}: ${n} intentos sin permiso en 24 h`,
      mensaje: 'Evalúe registrarla en el padrón (si es legítima) o informar al supervisor.',
      enlace: `/detecciones?placa=${placa}`,
      claveDedup: `reincidencia:${placa}:${new Date().toISOString().slice(0, 10)}`,
      datos: { placa, intentos: n },
    });
  } catch (e: any) {
    console.warn('[AVISOS] reincidencia:', e.message);
  }
}
