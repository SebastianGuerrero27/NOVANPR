import type { Permiso } from './permisos';
import { type Validado, validarEntero } from './validacion';

/**
 * Catálogo de notificaciones del sistema (dominio puro).
 *
 * Cada tipo declara su prioridad, a quién va (por PERMISO, no por rol: el enrutamiento sigue
 * automáticamente a la matriz RBAC), si exige reconocimiento (ACK), la ventana de supresión de
 * repeticiones y los canales. Inspirado en la gestión de alarmas ISA-18.2 / IEC 62682:
 *
 *   - Prioridades: critica > alta > media > baja (pocas alarmas de alta prioridad).
 *   - Ciclo de vida: nueva (sin reconocer) → reconocida (ACK) → resuelta (condición atendida,
 *     p. ej. el ingreso se validó). Una alarma crítica o alta sin reconocer se ESCALA.
 *   - Supresión de avalanchas: el mismo evento (clave) dentro de su ventana no crea otra
 *     alarma; incrementa `repeticiones` (evita la "fatiga de alarmas" del operador).
 */

export type Severidad = 'critica' | 'alta' | 'media' | 'baja';

export const ORDEN_SEVERIDAD: Record<Severidad, number> = { critica: 4, alta: 3, media: 2, baja: 1 };

export type TipoNotificacion =
  | 'acceso.alerta_seguridad'
  | 'acceso.no_registrado'
  | 'acceso.restringido'
  | 'acceso.vehiculo_no_coincide'
  | 'acceso.confirmacion'
  | 'acceso.reincidencia'
  | 'acceso.llegada_permiso'
  | 'padron.permiso_otorgado'
  | 'solicitud.nueva'
  | 'solicitud.resuelta'
  | 'padron.por_vencer'
  | 'alarma.escalada'
  | 'sistema.camara';

export interface DefinicionTipo {
  etiqueta: string;
  severidad: Severidad;
  /** Destinatarios por permiso (además de los usuarios explícitos de cada notificación) */
  permiso?: Permiso;
  requiereAck: boolean;
  /** Ventana de supresión de repeticiones (s). 0 = sin supresión. */
  ventanaS: number;
  /** Si hay un duplicado en la ventana: sumar una repetición o no hacer nada (resúmenes diarios) */
  alDuplicar: 'incrementar' | 'omitir';
  /** Enviar Web Push (además del tiempo real dentro de la aplicación) */
  push: boolean;
  /** Vigencia del mensaje push en el servicio del navegador (s): un aviso de garita caduca pronto */
  ttlPushS: number;
}

export const CATALOGO: Record<TipoNotificacion, DefinicionTipo> = {
  'acceso.alerta_seguridad': {
    etiqueta: 'Placa en lista negra', severidad: 'critica', permiso: 'avisos:seguridad',
    requiereAck: true, ventanaS: 120, alDuplicar: 'incrementar', push: true, ttlPushS: 300,
  },
  'acceso.no_registrado': {
    etiqueta: 'Vehículo sin permiso de ingreso', severidad: 'alta', permiso: 'avisos:acceso',
    requiereAck: true, ventanaS: 120, alDuplicar: 'incrementar', push: true, ttlPushS: 180,
  },
  'acceso.restringido': {
    etiqueta: 'Permiso fuera de horario o vigencia', severidad: 'alta', permiso: 'avisos:acceso',
    requiereAck: true, ventanaS: 120, alDuplicar: 'incrementar', push: true, ttlPushS: 180,
  },
  'acceso.vehiculo_no_coincide': {
    etiqueta: 'Vehículo distinto al registrado (posible placa clonada)', severidad: 'alta', permiso: 'avisos:acceso',
    requiereAck: true, ventanaS: 120, alDuplicar: 'incrementar', push: true, ttlPushS: 180,
  },
  'acceso.confirmacion': {
    etiqueta: 'Confirmación de ingreso requerida', severidad: 'media', permiso: 'avisos:garita',
    requiereAck: true, ventanaS: 120, alDuplicar: 'incrementar', push: false, ttlPushS: 0,
  },
  'acceso.reincidencia': {
    etiqueta: 'Intentos repetidos de una placa sin permiso', severidad: 'media', permiso: 'avisos:acceso',
    requiereAck: false, ventanaS: 86400, alDuplicar: 'omitir', push: false, ttlPushS: 0,
  },
  // Sin permiso de destino: va solo a quien otorgó el permiso del vehículo que llegó
  'acceso.llegada_permiso': {
    etiqueta: 'Llegó un vehículo con el permiso que otorgó', severidad: 'baja',
    requiereAck: false, ventanaS: 1800, alDuplicar: 'incrementar', push: true, ttlPushS: 3600,
  },
  'padron.permiso_otorgado': {
    etiqueta: 'Vehículo agregado a la lista blanca', severidad: 'baja', permiso: 'avisos:padron',
    requiereAck: false, ventanaS: 0, alDuplicar: 'incrementar', push: true, ttlPushS: 86400,
  },
  'solicitud.nueva': {
    etiqueta: 'Solicitud de acceso pendiente', severidad: 'media', permiso: 'solicitudes:resolver',
    requiereAck: false, ventanaS: 0, alDuplicar: 'incrementar', push: true, ttlPushS: 86400,
  },
  'solicitud.resuelta': {
    etiqueta: 'Solicitud de acceso resuelta', severidad: 'baja',
    requiereAck: false, ventanaS: 0, alDuplicar: 'incrementar', push: true, ttlPushS: 86400,
  },
  'padron.por_vencer': {
    etiqueta: 'Permisos por vencer', severidad: 'baja', permiso: 'padron:gestionar',
    requiereAck: false, ventanaS: 86400, alDuplicar: 'omitir', push: false, ttlPushS: 0,
  },
  'alarma.escalada': {
    etiqueta: 'Alarma no atendida (escalada)', severidad: 'critica', permiso: 'alarmas:escalamiento',
    requiereAck: true, ventanaS: 0, alDuplicar: 'incrementar', push: true, ttlPushS: 600,
  },
  'sistema.camara': {
    etiqueta: 'Cámara sin conexión', severidad: 'alta', permiso: 'avisos:sistema',
    requiereAck: false, ventanaS: 900, alDuplicar: 'incrementar', push: true, ttlPushS: 900,
  },
};

/** Prioridad de una alarma de lista negra según el nivel registrado. */
export function severidadDeNivel(nivel: string | null | undefined): Severidad {
  if (nivel === 'MEDIA') return 'media';
  if (nivel === 'ALTA') return 'alta';
  return 'critica';
}

export interface EstadoAlarma {
  severidad: Severidad;
  requiereAck: boolean;
  creada: Date;
  atendida: boolean;
  resuelta: boolean;
  escalada: boolean;
}

/**
 * ¿Debe escalarse? Solo alarmas que exigen ACK, de prioridad alta o crítica, sin atender ni
 * resolver, no escaladas aún y con más de `umbralS` segundos. `umbralS` = 0 desactiva.
 */
export function debeEscalar(a: EstadoAlarma, ahora: Date, umbralS: number): boolean {
  if (umbralS <= 0 || !a.requiereAck || a.atendida || a.resuelta || a.escalada) return false;
  if (ORDEN_SEVERIDAD[a.severidad] < ORDEN_SEVERIDAD.alta) return false;
  return ahora.getTime() - a.creada.getTime() >= umbralS * 1000;
}

/** Urgencia Web Push (RFC 8030 §5.3) según la prioridad. */
export function urgenciaPush(s: Severidad): 'very-low' | 'low' | 'normal' | 'high' {
  return s === 'critica' || s === 'alta' ? 'high' : s === 'media' ? 'normal' : 'low';
}

// ─── Consulta de la bandeja y de las métricas ────────────────────────────────

export const FILTROS_BANDEJA = ['no_leidas', 'pendientes'] as const;
export type FiltroBandeja = typeof FILTROS_BANDEJA[number];

export interface ConsultaBandeja {
  /** 1 a 100; por omisión 30 */
  limite: number;
  /** Paginación: notificaciones con id menor */
  antesDe: number | null;
  /** Recuperación tras reconectar: nuevas o modificadas después de este id */
  desde: number | null;
  filtro: FiltroBandeja | null;
}

/** Parámetros de la bandeja (?limite, ?antes_de, ?desde, ?filtro): un valor inválido se rechaza. */
export function leerConsultaBandeja(q: { limite?: unknown; antes_de?: unknown; desde?: unknown; filtro?: unknown }): Validado<ConsultaBandeja> {
  const limite = validarEntero(q.limite, { etiqueta: 'Límite', min: 1, max: 100 });
  if (!limite.ok) return limite;
  const antesDe = validarEntero(q.antes_de, { etiqueta: 'antes_de', min: 1 });
  if (!antesDe.ok) return antesDe;
  const desde = validarEntero(q.desde, { etiqueta: 'desde', min: 1 });
  if (!desde.ok) return desde;
  let filtro: FiltroBandeja | null = null;
  if (q.filtro !== undefined && q.filtro !== null && q.filtro !== '') {
    if (typeof q.filtro !== 'string' || !(FILTROS_BANDEJA as readonly string[]).includes(q.filtro)) {
      return { ok: false, error: `Filtro inválido. Valores: ${FILTROS_BANDEJA.join(', ')}.` };
    }
    filtro = q.filtro as FiltroBandeja;
  }
  return { ok: true, valor: { limite: limite.valor ?? 30, antesDe: antesDe.valor, desde: desde.valor, filtro } };
}

/** Período de las métricas del canal: 1 a 90 días; por omisión 7. */
export function leerDiasMetricas(valor: unknown): Validado<number> {
  const dias = validarEntero(valor, { etiqueta: 'Días', min: 1, max: 90 });
  return dias.ok ? { ok: true, valor: dias.valor ?? 7 } : dias;
}
