import { describirHorario, type Horario } from './horario';
import { CATEGORIAS_PERMISO, leerRegistroLista, LISTA_BLANCA, type RegistroLista } from './listas';
import { type ReglaTexto, type Validado, validarEntero, validarTexto } from './validacion';

/**
 * Solicitudes de acceso (dominio puro).
 *
 * El personal de garita pide autorizar una placa y quien tiene `solicitudes:resolver` la
 * aprueba —creando, reactivando o ampliando el permiso de la lista blanca— o la rechaza:
 *
 *   pendiente ──aprobar───▶ aprobada
 *       │ └────rechazar──▶ rechazada
 *       └──────cancelar──▶ cancelada   (solo quien la registró)
 *
 * Mientras está pendiente solo quien la registró puede editarla. Separación de funciones
 * (SoD, principio de los cuatro ojos): quien la registró nunca la resuelve.
 *
 * La solicitud describe el permiso que se pide, por eso se valida con las mismas reglas de la
 * lista blanca (placa ABC-1234 / AB-123C, responsable solo con letras, vehículo, vigencia y
 * horario) más el motivo del ingreso.
 */

export const ESTADOS_SOLICITUD = ['pendiente', 'aprobada', 'rechazada', 'cancelada'] as const;
export type EstadoSolicitud = typeof ESTADOS_SOLICITUD[number];

/** Mayor valor de una columna INT de SQL Server (identificador del paso vehicular). */
const MAX_ID = 2147483647;

export const REGLA_MOTIVO: ReglaTexto = { etiqueta: 'Motivo del ingreso', tipo: 'libre', min: 5, max: 300, requerido: true };
export const REGLA_COMENTARIO: ReglaTexto = { etiqueta: 'Comentario', tipo: 'libre', max: 300 };
export const REGLA_RECHAZO: ReglaTexto = { etiqueta: 'Motivo del rechazo', tipo: 'libre', min: 5, max: 300, requerido: true };

/** Solicitud lista para guardar (alta o edición). */
export interface DatosSolicitud {
  /** Placa, responsable, departamento, categoría, vehículo, vigencia (inicio / vence = fecha_fin) y horario */
  registro: RegistroLista;
  motivo: string;
  /** Paso vehicular que originó la solicitud */
  deteccionId: number | null;
}

/**
 * Valida el alta o la edición de una solicitud. `deteccionActual` es el paso de origen que se
 * conserva cuando el cuerpo no trae `deteccion_id` (la edición no pierde el vínculo).
 */
export function leerSolicitud(entrada: Record<string, unknown> | null | undefined, deteccionActual: number | null = null): Validado<DatosSolicitud> {
  const b = entrada ?? {};
  const registro = leerRegistroLista(LISTA_BLANCA, { ...b, fecha_vencimiento: b.fecha_fin, categoria: b.categoria || 'VISITANTE' });
  if (!registro.ok) return registro;
  const motivo = validarTexto(b.motivo, REGLA_MOTIVO);
  if (!motivo.ok) return motivo;
  const deteccion = validarEntero(b.deteccion_id, { etiqueta: 'Ingreso de origen', min: 1, max: MAX_ID });
  if (!deteccion.ok) return deteccion;
  return {
    ok: true,
    valor: { registro: registro.valor, motivo: motivo.valor!, deteccionId: b.deteccion_id === undefined ? deteccionActual : deteccion.valor },
  };
}

/** Lo que la aprobación toma de la solicitud guardada para conceder el permiso. */
export interface SolicitudAprobable {
  id: number;
  placa: string;
  propietario: string;
  departamento: string | null;
  categoria: string;
  motivo: string;
  vehiculo: { tipo: string | null; marca: string | null; modelo: string | null; color: string | null };
  /** AAAA-MM-DD */
  fecha_inicio: string | null;
  /** AAAA-MM-DD */
  fecha_fin: string | null;
  horario: Horario | null;
}

/**
 * Datos del permiso que concede la aprobación: lo solicitado con los ajustes opcionales de quien
 * resuelve (vigencia, horario, categoría y datos). La placa no se ajusta: se aprueba la placa
 * solicitada. El resultado se valida después con los casos de uso de listas (mismas reglas de la
 * lista blanca que un alta directa).
 */
export function datosAprobacion(s: SolicitudAprobable, ajustes: unknown): Validado<Record<string, unknown>> {
  const a = (ajustes && typeof ajustes === 'object' ? ajustes : {}) as Record<string, unknown>;
  const datos = {
    placa: s.placa,
    propietario: a.propietario ?? s.propietario,
    departamento: a.departamento ?? s.departamento,
    categoria: a.categoria ?? s.categoria,
    tipo_vehiculo: a.tipo_vehiculo ?? s.vehiculo.tipo,
    marca: a.marca ?? s.vehiculo.marca,
    modelo: a.modelo ?? s.vehiculo.modelo,
    color: a.color ?? s.vehiculo.color,
    observaciones: a.observaciones ?? `Solicitud #${s.id}: ${s.motivo}`.substring(0, 255),
    fecha_inicio: a.fecha_inicio !== undefined ? a.fecha_inicio : s.fecha_inicio,
    fecha_vencimiento: a.fecha_fin !== undefined ? a.fecha_fin : s.fecha_fin,
    horario: a.horario !== undefined ? a.horario : s.horario,
  };
  if (datos.categoria && !(CATEGORIAS_PERMISO as readonly string[]).includes(String(datos.categoria).toUpperCase())) {
    return { ok: false, error: 'Categoría inválida.' };
  }
  return { ok: true, valor: datos };
}

/** Cómo quedó el permiso de la lista blanca al aprobar (auditoría, aviso y respuesta). */
export const ACCION_APROBACION = {
  creado: 'permiso creado',
  reactivado: 'permiso reactivado',
  actualizado: 'permiso ampliado',
} as const;

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Campos que cambian en la edición de una solicitud (para la auditoría). */
export function cambiosSolicitud(anterior: SolicitudAprobable & { deteccion_id: number | null }, nueva: DatosSolicitud): string[] {
  const d = nueva.registro.datos;
  const pares: [string, unknown, unknown][] = [
    ['placa', anterior.placa, nueva.registro.placa],
    ['propietario', anterior.propietario, d.propietario],
    ['departamento', anterior.departamento, d.departamento],
    ['categoria', anterior.categoria, d.categoria],
    ['motivo', anterior.motivo, nueva.motivo],
    ['tipo_vehiculo', anterior.vehiculo.tipo, d.tipo_vehiculo],
    ['marca', anterior.vehiculo.marca, d.marca],
    ['modelo', anterior.vehiculo.modelo, d.modelo],
    ['color', anterior.vehiculo.color, d.color],
    ['fecha_inicio', anterior.fecha_inicio, iso(nueva.registro.inicio)],
    ['fecha_fin', anterior.fecha_fin, iso(nueva.registro.vence)],
    ['deteccion_id', anterior.deteccion_id, nueva.deteccionId],
  ];
  const cambios = pares.filter(([, a, b]) => String(a ?? '') !== String(b ?? '')).map(([campo]) => campo);
  // Ambos horarios están normalizados por validarHorario: la comparación de su JSON es exacta
  const horarioAnterior = anterior.horario?.length ? JSON.stringify(anterior.horario) : null;
  if (horarioAnterior !== nueva.registro.horario) cambios.push(`horario (${describirHorario(nueva.registro.horario)})`);
  return cambios;
}
