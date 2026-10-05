import {
  type Actor, errorConflicto, errorNoEncontrado, errorValidacion, type PuertoAuditoria, type PuertoEventos,
} from './comun';
import {
  camposModificados, type DefinicionLista, describirRegistro, leerRegistroLista, type RegistroLista,
} from '../dominio/listas';
import { validarTexto } from '../dominio/validacion';

/**
 * Casos de uso de las listas de control (lista blanca y lista negra):
 * consultar, ver detalle, registrar (o reactivar), editar y retirar (baja lógica con motivo).
 * Toda alta, edición o retiro queda en la auditoría y se difunde en tiempo real.
 */

/** Registro tal como lo entrega la API (con vigencia calculada y horario interpretado). */
export type RegistroListaDTO = Record<string, any> & { id: number; placa: string };

export interface RepositorioListas {
  listar(def: DefinicionLista): Promise<RegistroListaDTO[]>;
  obtener(def: DefinicionLista, id: number): Promise<RegistroListaDTO | null>;
  /** Fila guardada y activa (para comparar en la edición) */
  obtenerActivo(def: DefinicionLista, id: number): Promise<Record<string, any> | null>;
  buscarPorPlaca(def: DefinicionLista, placa: string): Promise<{ id: number; activo: boolean } | null>;
  existeOtraConPlaca(def: DefinicionLista, placa: string, idExcluido: number): Promise<boolean>;
  crear(def: DefinicionLista, r: RegistroLista, usuarioId: number, solicitudId?: number): Promise<number>;
  reactivar(def: DefinicionLista, id: number, r: RegistroLista, usuarioId: number, solicitudId?: number): Promise<void>;
  actualizar(def: DefinicionLista, id: number, r: RegistroLista): Promise<void>;
  /** Baja lógica; devuelve la placa retirada o null si no estaba activa */
  retirar(def: DefinicionLista, id: number): Promise<string | null>;
}

/** Avisos al personal cuando cambia una lista (p. ej. vehículo agregado a la lista blanca). */
export interface PuertoAvisosListas {
  registroAgregado(def: DefinicionLista, registro: RegistroListaDTO, actor: Actor): void;
}

export interface DependenciasListas {
  repositorio: RepositorioListas;
  auditoria: PuertoAuditoria;
  eventos: PuertoEventos;
  avisos: PuertoAvisosListas;
  describirHorario: (horario: string | null) => string;
}

export type AccionGuardado = 'creado' | 'reactivado' | 'actualizado';

export function casosListas(d: DependenciasListas) {
  const difundir = (def: DefinicionLista) => d.eventos.emitir('listas:actualizadas', { lista: def.entidad });

  const validar = (def: DefinicionLista, entrada: unknown): RegistroLista => {
    const r = leerRegistroLista(def, entrada as Record<string, unknown>);
    if (!r.ok) throw errorValidacion(r.error);
    return r.valor;
  };

  /**
   * Guarda un registro ya validado: lo crea, reactiva el retirado con la misma placa o, si ya
   * está activo, lo actualiza solo cuando `actualizarSiExiste` (aprobación que amplía un permiso).
   * No audita: lo hace quien orquesta (registrar o la aprobación de una solicitud).
   */
  async function guardar(def: DefinicionLista, r: RegistroLista, actor: Actor, opciones: { solicitudId?: number; actualizarSiExiste?: boolean } = {}) {
    const previo = await d.repositorio.buscarPorPlaca(def, r.placa);
    if (previo?.activo) {
      if (!opciones.actualizarSiExiste) throw errorConflicto(`La placa ${r.placa} ya está en la ${def.nombre}.`);
      await d.repositorio.actualizar(def, previo.id, r);
      return { id: previo.id, accion: 'actualizado' as AccionGuardado };
    }
    if (previo) {
      await d.repositorio.reactivar(def, previo.id, r, actor.id, opciones.solicitudId);
      return { id: previo.id, accion: 'reactivado' as AccionGuardado };
    }
    return { id: await d.repositorio.crear(def, r, actor.id, opciones.solicitudId), accion: 'creado' as AccionGuardado };
  }

  return {
    validar,
    guardar,
    difundir,
    /** Avisa al personal de un registro agregado por otra vía (p. ej. una solicitud aprobada). */
    anunciarAlta: (def: DefinicionLista, registro: RegistroListaDTO, actor: Actor) => d.avisos.registroAgregado(def, registro, actor),

    listar: (def: DefinicionLista) => d.repositorio.listar(def),

    async obtener(def: DefinicionLista, id: number) {
      const item = await d.repositorio.obtener(def, id);
      if (!item) throw errorNoEncontrado('Registro no encontrado.');
      return item;
    },

    async registrar(def: DefinicionLista, entrada: unknown, actor: Actor) {
      const r = validar(def, entrada);
      const { id, accion } = await guardar(def, r, actor);
      await d.auditoria.operacion(actor, accion === 'reactivado' ? 'LISTA_REACTIVADO' : 'LISTA_ALTA', def.entidad, id,
        describirRegistro(r, d.describirHorario));
      difundir(def);
      const item = (await d.repositorio.obtener(def, id))!;
      d.avisos.registroAgregado(def, item, actor);
      return { item, accion };
    },

    async editar(def: DefinicionLista, id: number, entrada: unknown, actor: Actor) {
      const r = validar(def, entrada);
      const anterior = await d.repositorio.obtenerActivo(def, id);
      if (!anterior) throw errorNoEncontrado('Registro no encontrado.');
      if (await d.repositorio.existeOtraConPlaca(def, r.placa, id)) throw errorConflicto(`Ya existe otro registro con la placa ${r.placa}.`);
      await d.repositorio.actualizar(def, id, r);
      const cambios = camposModificados(def, anterior, r, d.describirHorario);
      await d.auditoria.operacion(actor, 'LISTA_EDICION', def.entidad, id, `${r.placa}: ${cambios.join(', ') || 'sin cambios'}`);
      difundir(def);
      return (await d.repositorio.obtener(def, id))!;
    },

    async retirar(def: DefinicionLista, id: number, motivo: unknown, actor: Actor) {
      const m = validarTexto(motivo, { etiqueta: 'Motivo del retiro', tipo: 'libre', min: 5, max: 300, requerido: true });
      if (!m.ok) throw errorValidacion(m.error);
      const placa = await d.repositorio.retirar(def, id);
      if (!placa) throw errorNoEncontrado('Registro no encontrado.');
      await d.auditoria.operacion(actor, 'LISTA_RETIRO', def.entidad, id, `${placa} · ${m.valor}`);
      difundir(def);
    },
  };
}

export type CasosListas = ReturnType<typeof casosListas>;
