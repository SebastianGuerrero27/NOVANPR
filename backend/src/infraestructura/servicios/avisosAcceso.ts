import sql from 'mssql';
import { getDB } from '../db';
import { describirHorario } from '../../dominio/horario';
import { Decision, MOTIVO_RESTRICCION } from '../../dominio/decisionAcceso';
import { severidadDeNivel } from '../../dominio/notificaciones';
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
 *   autorizado                   → acceso.llegada_permiso    (solo a quien otorgó el permiso)
 *
 * Además, cada permiso otorgado se anuncia a la garita (padron.permiso_otorgado, avisos:padron)
 * con un enlace directo a la lista blanca filtrada por la placa.
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
  placa?: string | null;
  propietario?: string | null;
  /** Usuario que otorgó (o reactivó) el permiso */
  registrado_por?: number | null;
  horario?: string | null;
  fecha_inicio?: Date | string | null;
  fecha_vencimiento?: Date | string | null;
}

const lugar = (d: PasoNotificable) => (d.camara ? `${d.camara.nombre} (${d.camara.ubicacion})` : 'Acceso vehicular');
const fechaCorta = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : '');
/** Enlace a la lista blanca filtrada por la placa (el gestor de permisos llega a su vista única) */
export const enlaceListaBlanca = (placa: string) => `/listas/autorizados?q=${encodeURIComponent(placa)}`;

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
        mensaje: `${d.alerta?.motivo ?? 'Placa en la lista negra'} · ${lugar(d)}`,
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
        mensaje: `No consta en la lista blanca · ${lugar(d)}`,
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

    case 'autorizado':
      await notificarLlegada(d, permiso);
      return;

    default:
      return;
  }
}

/**
 * Llegó un vehículo con permiso vigente: se avisa SOLO a quien otorgó ese permiso (el gestor de
 * permisos no recibe los avisos de monitoreo, pero sí la confirmación de que su permiso se usó).
 * Las entradas y salidas repetidas de la misma placa en la ventana se agrupan como repeticiones.
 */
async function notificarLlegada(d: PasoNotificable, permiso?: ContextoPermiso | null): Promise<void> {
  if (!permiso?.registrado_por || !d.placa) return;
  const propietario = permiso.propietario ?? d.autorizado?.propietario ?? 'El titular del permiso';
  await notificar({
    tipo: 'acceso.llegada_permiso',
    titulo: `Llegó el vehículo autorizado · ${d.placa}`,
    mensaje: `${propietario} ingresó con el permiso que usted otorgó · ${lugar(d)}`,
    enlace: enlaceListaBlanca(d.placa),
    deteccionId: d.id,
    origen: new Date(d.fecha_hora_ingreso),
    datos: { deteccion_id: d.id, placa: d.placa },
    claveDedup: `llegada:${d.placa}:${permiso.registrado_por}`,
    destinatarios: { usuarios: [permiso.registrado_por] },
  });
}

export interface PermisoOtorgado {
  id: number;
  placa: string;
  propietario: string;
  marca?: string | null;
  modelo?: string | null;
  color?: string | null;
  fecha_vencimiento?: Date | string | null;
  horario?: string | null;
}

/**
 * Permiso de placa otorgado (alta en la lista blanca o solicitud aprobada): se notifica a la
 * garita para que sepa que el vehículo podrá ingresar. Quien lo otorgó no se lo notifica a sí mismo.
 */
export async function notificarPermisoOtorgado(p: PermisoOtorgado, autor: { id: number; nombre: string }): Promise<void> {
  const vehiculo = [[p.marca, p.modelo].filter(Boolean).join(' '), p.color].filter(Boolean).join(' ');
  const vigencia = [p.fecha_vencimiento ? `vigente hasta ${fechaCorta(p.fecha_vencimiento)}` : 'sin vencimiento',
    p.horario ? describirHorario(p.horario) : ''].filter(Boolean).join(' · ');
  try {
    await notificar({
      tipo: 'padron.permiso_otorgado',
      titulo: `Agregado a la lista blanca · ${p.placa}`,
      mensaje: `Se ha otorgado permiso a ${p.propietario} con vehículo${vehiculo ? ` ${vehiculo}` : ''} de placa ${p.placa} · ${vigencia} · por ${autor.nombre}`,
      enlace: enlaceListaBlanca(p.placa),
      datos: { vehiculo_autorizado_id: p.id, placa: p.placa },
      destinatarios: { excluir: [autor.id] },
    });
  } catch (e: any) {
    console.warn('[AVISOS] permiso otorgado:', e.message);
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
      mensaje: 'Si es legítima, solicite su permiso al gestor de permisos; si no, informe al administrador.',
      enlace: `/detecciones?placa=${placa}`,
      claveDedup: `reincidencia:${placa}:${new Date().toISOString().slice(0, 10)}`,
      datos: { placa, intentos: n },
    });
  } catch (e: any) {
    console.warn('[AVISOS] reincidencia:', e.message);
  }
}
