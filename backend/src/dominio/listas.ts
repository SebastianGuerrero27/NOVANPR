import type { Permiso } from './permisos';
import { validarHorario } from './horario';
import { type ReglaTexto, type Validado, validarFecha, validarPlaca, validarTexto } from './validacion';

/**
 * Listas de control (dominio puro):
 *
 *   lista blanca  vehículos autorizados: categoría, vigencia (desde/hasta) y franjas horarias
 *   lista negra   placas con alerta de seguridad: motivo y nivel
 *
 * Define los campos de cada lista con su regla de validación y convierte la entrada de una
 * persona en un registro válido. Las tablas y consultas viven en infraestructura.
 */

export type TipoLista = 'autorizados' | 'alertas';

export const CATEGORIAS_PERMISO = ['FUNCIONARIO', 'VISITANTE', 'PROVEEDOR', 'CONTRATISTA', 'OFICIAL', 'EMERGENCIA'] as const;
export const NIVELES_ALERTA = ['CRITICA', 'ALTA', 'MEDIA'] as const;

export interface CampoLista extends ReglaTexto {
  nombre: string;
  /** Valores permitidos (se guardan en mayúsculas) */
  valores?: readonly string[];
  omision?: string;
}

export interface DefinicionLista {
  tipo: TipoLista;
  /** Entidad para auditoría y eventos */
  entidad: 'autorizado' | 'lista_negra';
  nombre: string;
  campos: CampoLista[];
  /** Admite inicio de vigencia y franjas horarias (solo la lista blanca) */
  temporal: boolean;
  permisoEdicion: Permiso;
}

const CAMPOS_VEHICULO: CampoLista[] = [
  { nombre: 'tipo_vehiculo', etiqueta: 'Tipo de vehículo', tipo: 'alfanumerico', max: 50 },
  { nombre: 'marca', etiqueta: 'Marca', tipo: 'alfanumerico', max: 50 },
  { nombre: 'modelo', etiqueta: 'Modelo', tipo: 'alfanumerico', max: 50 },
  { nombre: 'color', etiqueta: 'Color', tipo: 'letras', max: 30 },
  { nombre: 'observaciones', etiqueta: 'Observaciones', tipo: 'libre', max: 255 },
];

export const LISTA_BLANCA: DefinicionLista = {
  tipo: 'autorizados', entidad: 'autorizado', nombre: 'lista blanca', temporal: true, permisoEdicion: 'padron:gestionar',
  campos: [
    { nombre: 'propietario', etiqueta: 'Propietario o responsable', tipo: 'nombre', max: 150, min: 3, requerido: true },
    { nombre: 'departamento', etiqueta: 'Departamento', tipo: 'alfanumerico', max: 100 },
    { nombre: 'categoria', etiqueta: 'Categoría', tipo: 'letras', max: 20, valores: CATEGORIAS_PERMISO, omision: 'FUNCIONARIO' },
    ...CAMPOS_VEHICULO,
  ],
};

export const LISTA_NEGRA: DefinicionLista = {
  tipo: 'alertas', entidad: 'lista_negra', nombre: 'lista negra', temporal: false, permisoEdicion: 'alertas:gestionar',
  campos: [
    { nombre: 'motivo', etiqueta: 'Motivo', tipo: 'libre', max: 255, min: 5, requerido: true },
    { nombre: 'nivel_alerta', etiqueta: 'Nivel', tipo: 'letras', max: 20, requerido: true, valores: NIVELES_ALERTA },
    ...CAMPOS_VEHICULO.filter(c => c.nombre !== 'tipo_vehiculo'),
  ],
};

export interface RegistroLista {
  placa: string;
  datos: Record<string, string | null>;
  vence: Date | null;
  inicio: Date | null;
  /** Franjas horarias serializadas (JSON) o null = sin restricción horaria */
  horario: string | null;
}

/** Valida y normaliza el alta o la edición de un registro de la lista. */
export function leerRegistroLista(def: DefinicionLista, entrada: Record<string, unknown> | null | undefined): Validado<RegistroLista> {
  const body = entrada ?? {};
  const placa = validarPlaca(body.placa);
  if (!placa.ok) return placa;

  const datos: Record<string, string | null> = {};
  for (const c of def.campos) {
    let valor = body[c.nombre];
    if ((valor === undefined || valor === null || valor === '') && c.omision) valor = c.omision;
    if (c.valores) {
      const v = String(valor ?? '').trim().toUpperCase();
      if (!v) {
        if (c.requerido) return { ok: false, error: `El campo «${c.etiqueta}» es obligatorio.` };
        datos[c.nombre] = null;
        continue;
      }
      if (!c.valores.includes(v)) return { ok: false, error: `${c.etiqueta} inválido. Valores: ${c.valores.join(', ')}.` };
      datos[c.nombre] = v;
      continue;
    }
    const texto = validarTexto(valor, c);
    if (!texto.ok) return texto;
    datos[c.nombre] = texto.valor;
  }

  const vence = validarFecha(body.fecha_vencimiento, { etiqueta: 'Fecha de vencimiento' });
  if (!vence.ok) return vence;
  let inicio: Date | null = null;
  let horario: string | null = null;
  if (def.temporal) {
    const ini = validarFecha(body.fecha_inicio, { etiqueta: 'Fecha de inicio' });
    if (!ini.ok) return ini;
    inicio = ini.valor;
    if (inicio && vence.valor && inicio > vence.valor) return { ok: false, error: 'La fecha de inicio no puede ser posterior al vencimiento.' };
    const h = validarHorario(body.horario);
    if (h.error) return { ok: false, error: h.error };
    horario = h.horario ? JSON.stringify(h.horario) : null;
  }
  return { ok: true, valor: { placa: placa.valor.placa, datos, vence: vence.valor, inicio, horario } };
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

/** Resumen legible de un alta para la auditoría. */
export function describirRegistro(r: RegistroLista, describirHorario: (h: string | null) => string): string {
  return [r.placa, r.inicio ? `desde ${iso(r.inicio)}` : '', r.vence ? `vence ${iso(r.vence)}` : '',
    r.horario ? describirHorario(r.horario) : ''].filter(Boolean).join(' · ');
}

/** Campos que cambian entre el registro guardado y la edición (para la auditoría). */
export function camposModificados(def: DefinicionLista, anterior: Record<string, any>, nuevo: RegistroLista, describirHorario: (h: string | null) => string): string[] {
  const cambios = [...def.campos.map(c => c.nombre), 'placa']
    .filter(c => String(anterior[c] ?? '') !== String(c === 'placa' ? nuevo.placa : nuevo.datos[c] ?? ''));
  const fecha = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : '');
  if (fecha(anterior.fecha_vencimiento) !== iso(nuevo.vence)) cambios.push('fecha_vencimiento');
  if (def.temporal && fecha(anterior.fecha_inicio) !== iso(nuevo.inicio)) cambios.push('fecha_inicio');
  if (def.temporal && (anterior.horario ?? null) !== nuevo.horario) cambios.push(`horario (${describirHorario(nuevo.horario)})`);
  return cambios;
}
