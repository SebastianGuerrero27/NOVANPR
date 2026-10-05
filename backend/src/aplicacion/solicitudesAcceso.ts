import {
  type Actor, errorConflicto, errorNoEncontrado, errorProhibido, errorValidacion, type PuertoAuditoria, type PuertoEventos,
} from './comun';
import { describirHorario, type Horario } from '../dominio/horario';
import { type DefinicionLista, LISTA_BLANCA, type RegistroLista } from '../dominio/listas';
import { type Rol, tienePermiso } from '../dominio/permisos';
import {
  ACCION_APROBACION, cambiosSolicitud, datosAprobacion, type DatosSolicitud, type EstadoSolicitud, leerSolicitud,
  REGLA_COMENTARIO, REGLA_RECHAZO,
} from '../dominio/solicitudesAcceso';
import { validarEntero, validarTexto } from '../dominio/validacion';

/**
 * Casos de uso de las solicitudes de acceso: listar, contar pendientes, crear, editar (solo
 * quien la registró y mientras está pendiente), aprobar (crea, reactiva o amplía el permiso de
 * la lista blanca con los casos de uso de listas), rechazar y cancelar.
 *
 * Separación de funciones (SoD, NIST RBAC dinámico): quien registró una solicitud no puede
 * resolverla aunque su rol tenga el permiso. La regla se aplica de forma atómica en el
 * repositorio (`reclamar`) para que dos personas no resuelvan la misma solicitud a la vez.
 *
 * Control de concurrencia optimista: cada edición incrementa la `version` de la solicitud y la
 * aprobación debe indicar la versión que revisó el gestor; si cambió mientras la revisaba (o entre
 * la lectura y el reclamo), no se aprueba (409) y el permiso nunca se concede a datos no revisados.
 * Todo cambio queda en la auditoría y se difunde con el evento `solicitudes:actualizadas`.
 */

const ENTIDAD = 'solicitud_acceso';
const SOLICITUD_CAMBIADA = 'La solicitud cambió mientras la revisaba: vuelva a abrirla para ver los datos actuales.';

/** Solicitud tal como la entrega la API. */
export interface SolicitudDTO {
  id: number;
  placa: string;
  propietario: string;
  departamento: string | null;
  categoria: string;
  motivo: string;
  vehiculo: { tipo: string | null; marca: string | null; modelo: string | null; color: string | null };
  fecha_inicio: string | null;
  fecha_fin: string | null;
  horario: Horario | null;
  horario_texto: string;
  deteccion_id: number | null;
  estado: EstadoSolicitud;
  solicitante: { id: number; nombre: string; email: string };
  fecha_solicitud: Date | string;
  resolutor: { id: number; nombre: string } | null;
  fecha_resolucion: Date | string | null;
  comentario_resolucion: string | null;
  vehiculo_autorizado_id: number | null;
  /** La placa tiene una alerta activa en la lista negra */
  en_lista_alertas: boolean;
  /** Permiso activo de la placa en la lista blanca (la aprobación lo amplía) */
  permiso_actual_id: number | null;
  /** Versión de los datos: cada edición la incrementa (control de concurrencia optimista) */
  version: number;
}

export type VistaSolicitudes = 'pendiente' | 'resueltas' | 'todas';

export interface RepositorioSolicitudes {
  /** Las 200 más recientes, primero las pendientes */
  listar(filtro: { usuarioId: number; soloPropias: boolean; vista: VistaSolicitudes }): Promise<SolicitudDTO[]>;
  /** Pendientes de otras personas (`deOtros`) o pendientes propias */
  contarPendientes(usuarioId: number, deOtros: boolean): Promise<number>;
  obtener(id: number): Promise<SolicitudDTO | null>;
  /** Id de una solicitud pendiente con la placa (sin contar `idExcluido`), o null */
  pendienteConPlaca(placa: string, idExcluido?: number): Promise<number | null>;
  crear(s: DatosSolicitud, usuarioId: number): Promise<number>;
  /** Edición atómica: solo si sigue pendiente y la registró `usuarioId`; false si no se cumplió */
  actualizar(id: number, s: DatosSolicitud, usuarioId: number): Promise<boolean>;
  /**
   * Marca la pendiente como resuelta si no la registró `usuarioId` y, con `version`, si sigue en esa
   * versión (atómico); null si no se pudo
   */
  reclamar(id: number, usuarioId: number, estado: 'aprobada' | 'rechazada', comentario: string | null, version?: number)
    : Promise<{ placa: string; solicitado_por: number } | null>;
  /** Devuelve a pendiente una aprobación que no pudo conceder el permiso */
  liberar(id: number): Promise<void>;
  vincularPermiso(id: number, permisoId: number): Promise<void>;
  /** Cancela una pendiente propia; devuelve la placa o null si no había ninguna */
  cancelar(id: number, usuarioId: number): Promise<string | null>;
}

/** Permiso de la lista blanca tal como lo entregan los casos de uso de listas. */
export type PermisoDTO = Record<string, any> & { id: number; placa: string };

/**
 * Lo que la aprobación usa de las listas de control: los casos de uso de listas (validar con las
 * reglas de la lista blanca, guardar, difundir, obtener y anunciar el alta a la garita).
 */
export interface PuertoListas {
  /** Registro válido de la lista o ErrorAplicacion de validación (400) */
  validar(def: DefinicionLista, entrada: unknown): RegistroLista;
  guardar(def: DefinicionLista, r: RegistroLista, actor: Actor, opciones: { solicitudId?: number; actualizarSiExiste?: boolean }):
    Promise<{ id: number; accion: keyof typeof ACCION_APROBACION }>;
  obtener(def: DefinicionLista, id: number): Promise<PermisoDTO>;
  difundir(def: DefinicionLista): void;
  anunciarAlta(def: DefinicionLista, registro: PermisoDTO, actor: Actor): void;
}

/** Notificación al gestor (solicitud nueva) o al solicitante (solicitud resuelta). */
export interface AvisoSolicitud {
  tipo: 'solicitud.nueva' | 'solicitud.resuelta';
  titulo: string;
  mensaje: string;
  enlace: string;
  datos: Record<string, unknown>;
  destinatarios: { usuarios?: number[]; excluir?: number[] };
}

export interface PuertoAvisosSolicitudes {
  /** Sin esperar: un fallo de notificación no interrumpe la operación */
  notificar(aviso: AvisoSolicitud): void;
}

export interface DependenciasSolicitudes {
  repositorio: RepositorioSolicitudes;
  listas: PuertoListas;
  auditoria: PuertoAuditoria;
  eventos: PuertoEventos;
  avisos: PuertoAvisosSolicitudes;
}

export function casosSolicitudes(d: DependenciasSolicitudes) {
  const avisar = () => d.eventos.emitir('solicitudes:actualizadas', {});
  const resuelve = (actor: Actor) => tienePermiso(actor.rol as Rol, 'solicitudes:resolver');

  const validar = (entrada: unknown, deteccionActual?: number | null): DatosSolicitud => {
    const r = leerSolicitud(entrada as Record<string, unknown>, deteccionActual);
    if (!r.ok) throw errorValidacion(r.error);
    return r.valor;
  };

  async function existente(id: number): Promise<SolicitudDTO> {
    const s = await d.repositorio.obtener(id);
    if (!s) throw errorNoEncontrado('Solicitud no encontrada.');
    return s;
  }

  /** Una sola solicitud pendiente por placa. */
  async function sinOtraPendiente(placa: string, idExcluido?: number) {
    const otra = await d.repositorio.pendienteConPlaca(placa, idExcluido);
    if (otra !== null) throw errorConflicto(`Ya existe una solicitud pendiente para ${placa} (#${otra}).`);
  }

  /** Solo quien la registró, y solo mientras está pendiente, puede editarla. */
  function verificarEditable(s: SolicitudDTO, actor: Actor) {
    if (s.solicitante.id !== actor.id) throw errorProhibido('Solo quien registró la solicitud puede editarla.');
    if (s.estado !== 'pendiente') throw errorConflicto(`La solicitud ya fue ${s.estado}: solo puede editarse mientras está pendiente.`);
  }

  /** Por qué no se puede resolver: es propia (SoD), cambió mientras se revisaba o ya se resolvió. */
  function noReclamable(s: SolicitudDTO, actor: Actor): never {
    if (s.solicitante.id === actor.id) {
      throw errorProhibido('Separación de funciones: no puede resolver una solicitud que usted mismo registró.');
    }
    if (s.estado === 'pendiente') throw errorConflicto(SOLICITUD_CAMBIADA);
    throw errorConflicto(`La solicitud ya fue ${s.estado}.`);
  }

  const rechazoDeReclamo = async (id: number, actor: Actor): Promise<never> => noReclamable(await existente(id), actor);

  return {
    /** Quien resuelve ve todas (o solo las suyas con `mias=1`); el resto, solo las propias. */
    listar(actor: Actor, consulta: { estado?: unknown; mias?: unknown }) {
      const estado = String(consulta.estado ?? 'pendiente');
      return d.repositorio.listar({
        usuarioId: actor.id,
        soloPropias: !resuelve(actor) || consulta.mias === '1',
        vista: estado === 'pendiente' || estado === 'resueltas' ? estado : 'todas',
      });
    },

    /** Contador del menú: para quien resuelve, las pendientes de otros (SoD); para el resto, las propias. */
    async resumen(actor: Actor) {
      return { pendientes: await d.repositorio.contarPendientes(actor.id, resuelve(actor)) };
    },

    async crear(entrada: unknown, actor: Actor) {
      const s = validar(entrada);
      await sinOtraPendiente(s.registro.placa);
      const id = await d.repositorio.crear(s, actor.id);
      await d.auditoria.operacion(actor, 'SOLICITUD_CREADA', ENTIDAD, id, `${s.registro.placa} · ${s.motivo}`);
      avisar();
      const { propietario, categoria } = s.registro.datos;
      d.avisos.notificar({
        tipo: 'solicitud.nueva',
        titulo: `Solicitud de acceso · ${s.registro.placa}`,
        mensaje: `${actor.nombre} solicita autorizar a ${propietario}${categoria ? ` (${categoria.toLowerCase()})` : ''}: ${s.motivo}`,
        enlace: `/solicitudes?id=${id}`,
        datos: { solicitud_id: id, placa: s.registro.placa },
        destinatarios: { excluir: [actor.id] },
      });
      return (await d.repositorio.obtener(id))!;
    },

    async editar(id: number, entrada: unknown, actor: Actor) {
      const actual = await existente(id);
      verificarEditable(actual, actor);
      const s = validar(entrada, actual.deteccion_id);
      await sinOtraPendiente(s.registro.placa, id);
      // Atómico: si se resolvió o canceló entre la lectura y la escritura, no se edita
      if (!(await d.repositorio.actualizar(id, s, actor.id))) {
        verificarEditable(await existente(id), actor);
        throw errorConflicto('La solicitud cambió mientras se editaba. Vuelva a intentarlo.');
      }
      const cambios = cambiosSolicitud(actual, s);
      await d.auditoria.operacion(actor, 'SOLICITUD_EDITADA', ENTIDAD, id, `${s.registro.placa}: ${cambios.join(', ') || 'sin cambios'}`);
      avisar();
      return (await d.repositorio.obtener(id))!;
    },

    /**
     * Aprueba la versión que revisó el gestor, con ajustes opcionales del permiso; sin permiso
     * concedido no hay aprobación.
     */
    async aprobar(id: number, entrada: { comentario?: unknown; ajustes?: unknown; version?: unknown } | undefined, actor: Actor) {
      const c = validarTexto(entrada?.comentario, REGLA_COMENTARIO);
      if (!c.ok) throw errorValidacion(c.error);
      const comentario = c.valor;
      const v = validarEntero(entrada?.version, { etiqueta: 'Versión de la solicitud', min: 1, requerido: true });
      if (!v.ok) throw errorValidacion(v.error);
      const version = v.valor!;
      const actual = await existente(id);
      if (actual.version !== version) noReclamable(actual, actor);
      const datos = datosAprobacion(actual, entrada?.ajustes);
      if (!datos.ok) throw errorValidacion(datos.error);
      // El permiso se valida igual que un alta directa en la lista blanca (casos de uso de listas)
      const registro = d.listas.validar(LISTA_BLANCA, datos.valor);

      // Atómico con la versión: si se editó después de leerla, no se reclama (el permiso sale de `actual`)
      const reclamada = await d.repositorio.reclamar(id, actor.id, 'aprobada', comentario, version);
      if (!reclamada) return rechazoDeReclamo(id, actor);

      let permisoId: number;
      let accion: string;
      try {
        // Si la placa ya tenía un permiso activo, la aprobación lo amplía (nuevas fechas u horario)
        const r = await d.listas.guardar(LISTA_BLANCA, registro, actor, { solicitudId: id, actualizarSiExiste: true });
        permisoId = r.id;
        accion = ACCION_APROBACION[r.accion];
        await d.repositorio.vincularPermiso(id, permisoId);
      } catch (e) {
        // Sin permiso no hay aprobación: la solicitud vuelve a quedar pendiente
        await d.repositorio.liberar(id);
        throw e;
      }

      await d.auditoria.operacion(actor, 'SOLICITUD_APROBADA', ENTIDAD, id,
        `${registro.placa} · ${accion} #${permisoId} · ${describirHorario(registro.horario)}${comentario ? ` · ${comentario}` : ''}`);
      d.listas.difundir(LISTA_BLANCA);
      avisar();
      const permiso = await d.listas.obtener(LISTA_BLANCA, permisoId);
      d.listas.anunciarAlta(LISTA_BLANCA, permiso, actor);
      d.avisos.notificar({
        tipo: 'solicitud.resuelta',
        titulo: `Solicitud aprobada · ${registro.placa}`,
        mensaje: `${actor.nombre} aprobó el ingreso de ${registro.datos.propietario} (${accion}).${comentario ? ` ${comentario}` : ''}`,
        enlace: actual.deteccion_id ? `/detecciones/${actual.deteccion_id}` : '/solicitudes',
        datos: { solicitud_id: id, placa: registro.placa, aprobada: true },
        destinatarios: { usuarios: [reclamada.solicitado_por] },
      });
      return { accion, solicitud: await d.repositorio.obtener(id), permiso };
    },

    async rechazar(id: number, comentario: unknown, actor: Actor) {
      const c = validarTexto(comentario, REGLA_RECHAZO);
      if (!c.ok) throw errorValidacion(c.error);
      const motivo = c.valor!;
      const s = await d.repositorio.reclamar(id, actor.id, 'rechazada', motivo);
      if (!s) return rechazoDeReclamo(id, actor);
      await d.auditoria.operacion(actor, 'SOLICITUD_RECHAZADA', ENTIDAD, id, `${s.placa} · ${motivo}`);
      avisar();
      d.avisos.notificar({
        tipo: 'solicitud.resuelta',
        titulo: `Solicitud rechazada · ${s.placa}`,
        mensaje: `${actor.nombre}: ${motivo}`,
        enlace: '/solicitudes',
        datos: { solicitud_id: id, placa: s.placa, aprobada: false },
        destinatarios: { usuarios: [s.solicitado_por] },
      });
      return (await d.repositorio.obtener(id))!;
    },

    /** Quien la registró la retira mientras está pendiente (baja lógica: queda como cancelada). */
    async cancelar(id: number, actor: Actor) {
      const placa = await d.repositorio.cancelar(id, actor.id);
      if (!placa) throw errorNoEncontrado('No hay una solicitud pendiente propia con ese número.');
      await d.auditoria.operacion(actor, 'SOLICITUD_CANCELADA', ENTIDAD, id, placa);
      avisar();
      return (await d.repositorio.obtener(id))!;
    },
  };
}

export type CasosSolicitudes = ReturnType<typeof casosSolicitudes>;
