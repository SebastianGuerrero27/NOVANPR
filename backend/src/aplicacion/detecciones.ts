import {
  type Actor, errorNoEncontrado, errorProhibido, errorValidacion, type PuertoAuditoria, type PuertoEventos,
} from './comun';
import {
  type Decision, decidirAcceso, type EstadoValidacion, MOTIVO_RESTRICCION, type PoliticaAutorizacion,
} from '../dominio/decisionAcceso';
import {
  csvDetecciones, ETIQUETA_ESTADO, type FilaExportacion, type FiltrosDetecciones, fechaHoraLocal, leerDatosValidacion, leerFiltros,
  leerLimite, leerPaginacion, leerPlacaConsulta, leerRegistroManual, lecturaUtilizable, REGLA_MOTIVO_ELIMINACION,
  REGLA_MOTIVO_ELIMINACION_MASIVA, tieneFiltros, tipoPorFormato,
} from '../dominio/detecciones';
import { describirHorario, evaluarVigencia, type Vigencia } from '../dominio/horario';
import { type Rol, tienePermiso } from '../dominio/permisos';
import { normalizarPlaca, validarPlaca, validarTexto } from '../dominio/validacion';

/**
 * Detecciones vehiculares: cada registro es un paso por un acceso.
 *
 * Servicio ANPR (X-Servicio-Token): fase 1 (captura, pendiente de OCR), fase 2 (lectura y cruce
 * con las listas) y descartes. Sus cuerpos se interpretan igual que siempre: la cámara informa lo
 * que lee y el cruce tolera los errores del OCR, así que aquí NO se exige el formato de placa.
 *
 * Personal: historial con filtros, recientes, exportación, situación de una placa, detalle,
 * validación (con excepción auditada), registro manual y eliminación (individual o masiva). Lo
 * que escribe una persona sí se valida con dominio/validacion.ts (placa ANT, motivos, tipo…).
 *
 * La decisión de acceso la toma la política pura de dominio/decisionAcceso.ts; este módulo reúne
 * las evidencias, persiste el resultado y lo difunde (Socket.IO y centro de notificaciones).
 */

export type Fila = Record<string, any>;

/** Detección tal como la entrega la API y los eventos en tiempo real. */
export type DeteccionDTO = Record<string, any> & { id: number; placa: string | null; estado_validacion: EstadoValidacion };

/** Evidencias de las listas para una placa en el instante del paso. */
export interface Cruce {
  /** Coincidencia con la lista negra (tolerante a homoglifos del OCR) */
  alerta: Fila | null;
  /** Permiso de la lista blanca (coincidencia exacta); no se considera si hay alerta */
  permiso: Fila | null;
  vigencia: Vigencia | null;
}

export interface NuevoIngreso {
  trackingId: number;
  /** Placa adelantada por el motor (≥ 4 caracteres) o null */
  pista: string | null;
  ruta: string;
  confianza: number | null;
  fuente: string;
  camaraId: number | null;
}

export interface LecturaAutomatica {
  placaOriginal: string;
  confianza: number | null;
  decision: string;
  lecturaVerificador: unknown;
  latenciaMs: unknown;
}

/** Atributos observados del vehículo en el paso (segundo factor). */
export interface Observacion {
  confianza_deteccion: number | null;
  fecha_hora_ingreso: Date | string;
  marca: string | null;
  color: string | null;
  tipo: string | null;
}

export interface Descarte {
  trackingId: number;
  motivo: string;
  texto: string | null;
  confianza: number | null;
  fuente: string | null;
  camaraId: number | null;
}

export interface RepositorioDetecciones {
  obtener(id: number): Promise<Fila | null>;
  /** Ingreso del mismo paso físico (mismo tracking o misma placa en la ventana de 35 s) */
  mismoPaso(trackingId: number, pista: string): Promise<{ id: number; fecha_hora_ingreso: Date } | null>;
  existeCamara(id: number): Promise<boolean>;
  crearIngreso(n: NuevoIngreso): Promise<{ id: number; fecha_hora_ingreso: Date }>;
  guardarMetadatos(id: number, metadatos: unknown): Promise<void>;
  registrarLecturaAutomatica(id: number, l: LecturaAutomatica): Promise<void>;
  marcarNoLegible(id: number, rutaPlaca: string | null): Promise<void>;
  /** Otro paso ya procesado con la misma placa en la ventana de 35 s */
  pasoProcesadoConPlaca(idExcluido: number, placa: string): Promise<number | null>;
  eliminarPendiente(id: number): Promise<void>;
  guardarVeredicto(id: number, valida: boolean | null, evidencia: string | null): Promise<void>;
  observacion(id: number): Promise<Observacion | null>;
  guardarVerificacion(id: number, resultado: string, detalle: string): Promise<void>;
  guardarDecisionAutomatica(id: number, d: { placa: string; confianza: number | null; rutaPlaca: string | null; tipo: string | null },
    cruce: Cruce, decision: Decision): Promise<void>;
  registrarDescarte(d: Descarte): Promise<void>;
  contar(f: FiltrosDetecciones): Promise<number>;
  pagina(f: FiltrosDetecciones, offset: number, tamano: number): Promise<Fila[]>;
  recientes(limite: number): Promise<Fila[]>;
  exportar(f: FiltrosDetecciones): Promise<Fila[]>;
  /** Últimos 10 pasos de una placa (sin contar `excluirId`) */
  historialPlaca(placa: string, excluirId?: number): Promise<Fila[]>;
  auditoriaDe(id: number): Promise<Fila[]>;
  guardarValidacion(id: number, d: { placa: string; tipo: string | null; usuarioId: number }, cruce: Cruce, decision: Decision): Promise<void>;
  crearManual(d: { placa: string; camaraId: number | null; tipo: string | null; usuarioId: number }, cruce: Cruce, decision: Decision): Promise<number>;
  eliminar(id: number): Promise<void>;
  /** Elimina las que cumplen los filtros (todas si `f` es null) y devuelve sus rutas de evidencia */
  eliminarFiltradas(f: FiltrosDetecciones | null): Promise<{ id: number; ruta_imagen_ingreso: string | null; ruta_imagen_placa: string | null }[]>;
}

/** Búsqueda en las listas de control: lista negra aproximada y permiso exacto de la lista blanca. */
export interface PuertoListasDetecciones {
  alerta(placa: string): Promise<{ row: Fila; coincidencia: 'exacta' | 'aproximada' } | null>;
  permiso(placa: string): Promise<Fila | null>;
}

export interface DependenciasDetecciones {
  repositorio: RepositorioDetecciones;
  listas: PuertoListasDetecciones;
  /** Representación de una fila para la API (imágenes firmadas y motivo de revisión) */
  presentar(fila: Fila, detalle?: boolean): DeteccionDTO;
  politica: () => PoliticaAutorizacion;
  /** Segundo factor: atributos registrados frente a observados (marca, color, tipo) */
  compararVehiculo(registrado: Fila, observado: Observacion): { resultado: 'coincide' | 'no_coincide' | 'sin_datos'; detalle: string };
  avisos: {
    /** Aviso de garita o al gestor que otorgó el permiso; sin esperar */
    decision(dto: DeteccionDTO, decision: Decision, permiso: Fila | null): void;
    /** La persona atendió el paso: sus alarmas pendientes se resuelven */
    resolverPorDeteccion(id: number): Promise<void>;
  };
  evidencia: { eliminar(rutas: (string | null | undefined)[]): Promise<number> };
  eventos: PuertoEventos;
  auditoria: PuertoAuditoria;
  tiempo: { ahora(): Date; zona: string };
}

type Entrada = Record<string, any>;
const cuerpo = (entrada: unknown): Entrada => (entrada && typeof entrada === 'object' ? entrada as Entrada : {});

const entradaListas = (c: Cruce) => ({
  alerta: c.alerta ? { id: c.alerta.id as number, coincidencia: c.alerta.coincidencia } : null,
  permiso: c.permiso ? { id: c.permiso.id as number, vigencia: c.vigencia! } : null,
});

export function casosDetecciones(d: DependenciasDetecciones) {
  /** Lee la detección completa y la difunde a las sesiones conectadas. */
  async function difundir(id: number, evento: 'deteccion:nueva' | 'deteccion:actualizada'): Promise<DeteccionDTO | null> {
    const fila = await d.repositorio.obtener(id);
    if (!fila) return null;
    const dto = d.presentar(fila);
    d.eventos.emitir(evento, dto);
    if (dto.estado_validacion === 'alerta') d.eventos.emitir('deteccion:alerta', dto);
    return dto;
  }

  /** Lista negra (aproximada) y, si no hay alerta, permiso exacto con su estado en el instante del paso. */
  async function cruzarListas(placa: string, instante: Date): Promise<Cruce> {
    const alerta = await d.listas.alerta(placa);
    if (alerta) return { alerta: { ...alerta.row, coincidencia: alerta.coincidencia }, permiso: null, vigencia: null };
    const permiso = await d.listas.permiso(placa);
    return { alerta: null, permiso, vigencia: permiso ? evaluarVigencia(permiso, instante, d.tiempo.zona) : null };
  }

  const filtros = (consulta: Entrada) => {
    const f = leerFiltros(consulta);
    if (!f.ok) throw errorValidacion(f.error);
    return f.valor;
  };

  const avisarSiCorresponde = (dto: DeteccionDTO | null, decision: Decision, permiso: Fila | null) => {
    if (dto && (decision.estado === 'alerta' || decision.estado === 'autorizado')) d.avisos.decision(dto, decision, permiso);
  };

  return {
    // ─── Servicio ANPR ─────────────────────────────────────────────────────────

    /**
     * Fase 1 · captura. Un paso físico = un registro: se reutiliza el ingreso del mismo tracking o
     * de la misma placa dentro de la ventana de 35 s.
     */
    async ingreso(entrada: unknown) {
      const b = cuerpo(entrada);
      const { tracking_id, ruta_imagen_ingreso, confianza_deteccion = null, fuente = 'webcam', camara_id = null, placa = null } = b;
      if (!ruta_imagen_ingreso) throw errorValidacion('La ruta de la imagen de ingreso es obligatoria.');
      const trackingId = Number.isInteger(tracking_id) ? tracking_id : -1;
      const pista = typeof placa === 'string' ? normalizarPlaca(placa) : '';

      const previo = await d.repositorio.mismoPaso(trackingId, pista);
      if (previo) {
        return {
          nuevo: false,
          respuesta: { message: 'Registro existente reutilizado (mismo paso físico).', ingreso_id: previo.id, fecha_hora_ingreso: previo.fecha_hora_ingreso, deduplicado: true },
        };
      }

      let camaraId: number | null = null;
      if (camara_id !== null && Number.isInteger(Number(camara_id)) && await d.repositorio.existeCamara(Number(camara_id))) camaraId = Number(camara_id);

      const creado = await d.repositorio.crearIngreso({
        trackingId, pista: pista.length >= 4 ? pista : null, ruta: String(ruta_imagen_ingreso).substring(0, 255),
        confianza: typeof confianza_deteccion === 'number' ? confianza_deteccion : null, fuente: String(fuente).substring(0, 255), camaraId,
      });
      await d.repositorio.guardarMetadatos(creado.id, b.metadatos);
      await difundir(creado.id, 'deteccion:nueva');
      return { nuevo: true, respuesta: { message: 'Ingreso registrado (pendiente de OCR).', ingreso_id: creado.id, fecha_hora_ingreso: creado.fecha_hora_ingreso } };
    },

    /** Fase 2 · lectura OCR, segundo factor y decisión de acceso. */
    async completarOcr(entrada: unknown) {
      const { ingreso_id, placa_reconocida, confianza_ocr, ruta_imagen_placa, estado_procesamiento = 'procesado',
        lectura_verificador = null, latencia_ms = null, lectura_valida = null, evidencia_lectura = null } = cuerpo(entrada);
      // Veredicto del motor sobre la lectura (null si el motor no lo informa)
      const validez: boolean | null = typeof lectura_valida === 'boolean' ? lectura_valida : null;
      const evidencia = evidencia_lectura && typeof evidencia_lectura === 'object' ? JSON.stringify(evidencia_lectura).substring(0, 1500) : null;
      if (!Number.isInteger(ingreso_id)) throw errorValidacion('El ID de ingreso es obligatorio.');
      const id = ingreso_id as number;

      let placa = normalizarPlaca(placa_reconocida);
      const confianza = typeof confianza_ocr === 'number' ? confianza_ocr : null;
      const rutaPlaca = ruta_imagen_placa || null;
      const lecturaAutomatica = (decision: string) => d.repositorio.registrarLecturaAutomatica(id, {
        placaOriginal: placa, confianza, decision, lecturaVerificador: lectura_verificador, latenciaMs: latencia_ms,
      });

      // Sin lectura utilizable: queda para validación del personal (no se elimina la evidencia)
      if (!lecturaUtilizable(estado_procesamiento, placa)) {
        await d.repositorio.marcarNoLegible(id, rutaPlaca);
        await lecturaAutomatica('pendiente_revision');
        return { message: 'Ingreso pendiente de validación manual.', deteccion: await difundir(id, 'deteccion:actualizada') };
      }

      // Mismo paso físico ya procesado con la misma placa: se consolida
      const previo = await d.repositorio.pasoProcesadoConPlaca(id, placa);
      if (previo !== null) {
        await d.repositorio.eliminarPendiente(id);
        d.eventos.emitir('deteccion:eliminada', { id, consolidado_en: previo });
        return { message: 'Detección consolidada con el paso previo.', deduplicado: true, ingreso_id: previo };
      }

      await d.repositorio.guardarVeredicto(id, validez, evidencia);
      const obs = await d.repositorio.observacion(id);
      if (!obs) throw errorNoEncontrado('Ingreso no encontrado.');

      // El acceso se juzga en el instante del paso (horario y vigencia del permiso)
      const cruce = await cruzarListas(placa, new Date(obs.fecha_hora_ingreso));
      let tipo: string | null = tipoPorFormato(placa);
      if (cruce.permiso) {
        placa = normalizarPlaca(cruce.permiso.placa) || placa;
        tipo = cruce.permiso.tipo_vehiculo || tipo;
      }

      // Segundo factor: marca / color / tipo observados frente a los registrados (posible placa clonada)
      const registrado = cruce.alerta ?? cruce.permiso;
      let verificacion: ReturnType<DependenciasDetecciones['compararVehiculo']> | null = null;
      if (registrado) {
        verificacion = d.compararVehiculo(registrado, obs);
        if (verificacion.resultado === 'no_coincide') console.warn(`[SEGUNDO FACTOR] Ingreso #${id} ${placa}: ${verificacion.detalle}`);
        await d.repositorio.guardarVerificacion(id, verificacion.resultado, verificacion.detalle.substring(0, 255));
      }

      const decision = decidirAcceso({
        origen: 'automatico',
        ...entradaListas(cruce),
        lectura: { lecturaValida: validez, confianzaOcr: confianza, confianzaDeteccion: obs.confianza_deteccion ?? null },
        verificacionVehiculo: verificacion?.resultado ?? null,
        politica: d.politica(),
      });
      console.log(`[DECISION] Ingreso #${id} ${placa}: ${decision.estado} (${decision.regla}: ${decision.motivos.join('; ')})`);

      await d.repositorio.guardarDecisionAutomatica(id, { placa, confianza, rutaPlaca, tipo }, cruce, decision);
      await lecturaAutomatica(decision.estado);
      const dto = await difundir(id, 'deteccion:actualizada');
      if (dto) d.avisos.decision(dto, decision, cruce.permiso);
      return { message: 'OCR completado.', deteccion: dto };
    },

    /** Auditoría de los falsos positivos que el motor descartó. */
    async descarte(entrada: unknown) {
      const { tracking_id, motivo, texto_candidato, confianza, fuente, camara_id } = cuerpo(entrada);
      await d.repositorio.registrarDescarte({
        trackingId: Number.isInteger(tracking_id) ? tracking_id : -1,
        motivo: String(motivo || 'falso_positivo_ocr').substring(0, 100),
        texto: texto_candidato ? String(texto_candidato).substring(0, 50) : null,
        confianza: typeof confianza === 'number' ? confianza : null,
        fuente: fuente ? String(fuente).substring(0, 255) : null,
        camaraId: Number.isInteger(camara_id) ? camara_id : null,
      });
      return { success: true };
    },

    // ─── Consultas del personal ───────────────────────────────────────────────

    async listar(consulta: Entrada) {
      const f = filtros(consulta);
      const p = leerPaginacion(consulta);
      if (!p.ok) throw errorValidacion(p.error);
      const { pagina, tamano } = p.valor;
      const total = await d.repositorio.contar(f);
      const filas = await d.repositorio.pagina(f, (pagina - 1) * tamano, tamano);
      return { items: filas.map(x => d.presentar(x)), total, pagina, tamano };
    },

    async recientes(limite: unknown) {
      return (await d.repositorio.recientes(leerLimite(limite))).map(x => d.presentar(x));
    },

    /** CSV del historial con los mismos filtros; la exportación queda en la auditoría. */
    async exportar(consulta: Entrada, actor: Actor) {
      const f = filtros(consulta);
      const filas = await d.repositorio.exportar(f);
      const contenido = csvDetecciones(filas as FilaExportacion[]);
      await d.auditoria.operacion(actor, 'EXPORTACION', 'deteccion', null, `${filas.length} registros · ${JSON.stringify(consulta).substring(0, 300)}`);
      return { nombre: `ingresos_anpr_${d.tiempo.ahora().toISOString().slice(0, 10)}.csv`, contenido };
    },

    /** Situación actual de una placa en las listas y sus últimos pasos. */
    async buscarPlaca(valor: unknown) {
      const p = leerPlacaConsulta(valor);
      if (!p.ok) throw errorValidacion(p.error);
      const placa = p.valor;
      const cruce = await cruzarListas(placa, d.tiempo.ahora());
      const decision = decidirAcceso({ origen: 'manual', ...entradaListas(cruce), politica: d.politica() });
      const historial = await d.repositorio.historialPlaca(placa);
      return {
        placa,
        estado: decision.estado === 'no_reconocido' ? (cruce.permiso ? 'restringido' : 'no_registrado') : decision.estado,
        restriccion: decision.restriccion,
        motivo: decision.restriccion ? MOTIVO_RESTRICCION[decision.restriccion] : null,
        alerta: cruce.alerta,
        autorizado: cruce.permiso ? { ...cruce.permiso, horario_texto: describirHorario(cruce.permiso.horario) } : null,
        ultimos_ingresos: historial.map(x => d.presentar(x)),
      };
    },

    /** Detalle con la lectura automática, la captura, la auditoría y los pasos anteriores de la placa. */
    async detalle(id: number) {
      const fila = await d.repositorio.obtener(id);
      if (!fila) throw errorNoEncontrado('Detección no encontrada.');
      const dto = d.presentar(fila, true);
      const [auditoria, anteriores] = await Promise.all([
        d.repositorio.auditoriaDe(id),
        dto.placa ? d.repositorio.historialPlaca(normalizarPlaca(dto.placa), id) : Promise.resolve([] as Fila[]),
      ]);
      return { ...dto, auditoria, pasos_anteriores: anteriores.map(x => d.presentar(x)) };
    },

    // ─── Acciones del personal ────────────────────────────────────────────────

    /**
     * Corrección o confirmación de la placa por el personal. Con `excepcion`, una persona con
     * accesos:excepcion concede el paso pese a la restricción temporal del permiso (motivo auditado).
     */
    async validar(id: number, entrada: unknown, actor: Actor) {
      const b = cuerpo(entrada);
      const placa = validarPlaca(b.placa_validada);
      if (!placa.ok) throw errorValidacion(placa.error);
      const excepcion = b.excepcion === true;
      if (excepcion && !tienePermiso(actor.rol as Rol, 'accesos:excepcion')) {
        throw errorProhibido('No tiene permiso para autorizar ingresos por excepción.');
      }
      const datos = leerDatosValidacion(b, excepcion);
      if (!datos.ok) throw errorValidacion(datos.error);
      const { tipoVehiculo, observacion } = datos.valor;

      const actual = await d.repositorio.obtener(id);
      if (!actual) throw errorNoEncontrado('Detección no encontrada.');

      const cruce = await cruzarListas(placa.valor.placa, new Date(actual.fecha_hora_ingreso));
      const decision = decidirAcceso({ origen: 'manual', ...entradaListas(cruce), excepcion, politica: d.politica() });
      const final = cruce.permiso ? normalizarPlaca(cruce.permiso.placa) || placa.valor.placa : placa.valor.placa;
      await d.repositorio.guardarValidacion(id, {
        placa: final, tipo: tipoVehiculo || cruce.permiso?.tipo_vehiculo || tipoPorFormato(final), usuarioId: actor.id,
      }, cruce, decision);

      const antes = actual.placa_validada || actual.placa_reconocida || 'sin lectura';
      await d.auditoria.operacion(actor, decision.regla === 'R2-excepcion' ? 'EXCEPCION_ACCESO' : 'VALIDACION', 'deteccion', id,
        `${antes} → ${final} (${ETIQUETA_ESTADO[decision.estado]}${decision.restriccion ? ` · ${MOTIVO_RESTRICCION[decision.restriccion]}` : ''})${observacion ? ` · ${observacion}` : ''}`);
      // La persona atendió el paso: sus alarmas se resuelven
      await d.avisos.resolverPorDeteccion(id);
      const dto = await difundir(id, 'deteccion:actualizada');
      // Si la corrección revela una alerta se avisa; si confirma un permiso, se avisa a quien lo otorgó
      if (decision.estado !== actual.estado_validacion) avisarSiCorresponde(dto, decision, cruce.permiso);
      return { message: 'Validación registrada.', deteccion: dto };
    },

    /**
     * Paso registrado a mano (cámara fuera de servicio, placa ilegible…). Se cruza con las listas
     * igual que una lectura automática y NO modifica la lista blanca.
     */
    async registroManual(entrada: unknown, actor: Actor) {
      const r = leerRegistroManual(cuerpo(entrada));
      if (!r.ok) throw errorValidacion(r.error);
      const { placa, motivo, camaraId, tipoVehiculo } = r.valor;
      const cruce = await cruzarListas(placa, d.tiempo.ahora());
      const decision = decidirAcceso({ origen: 'manual', ...entradaListas(cruce), politica: d.politica() });
      const id = await d.repositorio.crearManual({
        placa, camaraId, tipo: tipoVehiculo || cruce.permiso?.tipo_vehiculo || tipoPorFormato(placa), usuarioId: actor.id,
      }, cruce, decision);
      await d.auditoria.operacion(actor, 'REGISTRO_MANUAL', 'deteccion', id, `${placa} (${ETIQUETA_ESTADO[decision.estado]}) · ${motivo}`);
      const dto = await difundir(id, 'deteccion:nueva');
      avisarSiCorresponde(dto, decision, cruce.permiso);
      return { message: 'Ingreso registrado manualmente.', deteccion: dto };
    },

    /** Elimina una detección y su evidencia fotográfica, con motivo auditado. */
    async eliminar(id: number, motivo: unknown, actor: Actor) {
      const m = validarTexto(motivo, REGLA_MOTIVO_ELIMINACION);
      if (!m.ok) throw errorValidacion(m.error);
      const fila = await d.repositorio.obtener(id);
      if (!fila) throw errorNoEncontrado('Detección no encontrada.');
      await d.repositorio.eliminar(id);
      const archivos = await d.evidencia.eliminar([fila.ruta_imagen_ingreso, fila.ruta_imagen_placa]);
      await d.auditoria.operacion(actor, 'DETECCION_ELIMINADA', 'deteccion', id,
        `${fila.placa_validada || fila.placa_reconocida || 'sin lectura'} del ${fechaHoraLocal(fila.fecha_hora_ingreso)} · ${archivos} imágenes · ${m.valor}`);
      d.eventos.emitir('deteccion:eliminada', { id });
      await d.avisos.resolverPorDeteccion(id);
      return { message: 'Detección eliminada.', id };
    },

    /**
     * Eliminación masiva: todas las detecciones o las que cumplen los filtros del historial. Exige
     * escribir ELIMINAR y un motivo; borra la evidencia y queda en la auditoría con la cantidad y
     * los filtros usados.
     */
    async eliminarMasivo(consulta: Entrada, entrada: unknown, actor: Actor) {
      const b = cuerpo(entrada);
      if (b.confirmacion !== 'ELIMINAR') throw errorValidacion('Escriba ELIMINAR para confirmar.');
      const m = validarTexto(b.motivo, REGLA_MOTIVO_ELIMINACION_MASIVA);
      if (!m.ok) throw errorValidacion(m.error);
      const f = filtros(consulta);
      // Sin filtros se eliminan todas, en cualquier estado de procesamiento
      const conFiltros = tieneFiltros(consulta);
      const filas = await d.repositorio.eliminarFiltradas(conFiltros ? f : null);
      const archivos = await d.evidencia.eliminar(filas.flatMap(x => [x.ruta_imagen_ingreso, x.ruta_imagen_placa]));
      const alcance = conFiltros ? `filtros ${JSON.stringify(consulta).substring(0, 200)}` : 'todas las detecciones';
      await d.auditoria.operacion(actor, 'DETECCIONES_ELIMINADAS', 'deteccion', null, `${filas.length} registros y ${archivos} imágenes · ${alcance} · ${m.valor}`);
      d.eventos.emitir('deteccion:eliminadas', { total: filas.length });
      return { message: `${filas.length} ${filas.length === 1 ? 'registro eliminado' : 'registros eliminados'}.`, total: filas.length };
    },
  };
}

export type CasosDetecciones = ReturnType<typeof casosDetecciones>;
