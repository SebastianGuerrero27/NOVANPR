import { type Actor, errorNoEncontrado, errorValidacion, type PuertoAuditoria } from './comun';
import {
  CAMPOS_AUDITORIA, esFuenteAuditoria, type FiltrosAuditoria, type FuenteAuditoria, generarCsv, leerFiltrosAuditoria,
  leerPaginacion, MAX_FILAS_EXPORTACION, validarDiasRetencion, validarIdAuditoria,
} from '../dominio/auditoria';

/**
 * Casos de uso de la auditoría: consultar (paginado), exportar a CSV, ver el detalle de un
 * registro y aplicar la retención. Ninguno edita ni borra registros: la retención los traslada
 * a las tablas de archivo, y tanto la exportación como la retención quedan a su vez auditadas
 * (NIST SP 800-92: el acceso a los registros también es un evento a registrar).
 */

/** Registro tal como lo entrega la base (columnas de la fuente). */
export type RegistroAuditoria = Record<string, unknown>;

export interface ConteoArchivado {
  operaciones: number;
  cuentas: number;
  accesos: number;
}

export interface RepositorioAuditoria {
  contar(f: FiltrosAuditoria): Promise<number>;
  /** Columnas resumidas para la pantalla, más recientes primero */
  pagina(f: FiltrosAuditoria, desplazamiento: number, tamano: number): Promise<RegistroAuditoria[]>;
  /** Columnas completas (CAMPOS_AUDITORIA), más recientes primero, hasta `limite` registros */
  completos(f: FiltrosAuditoria, limite: number): Promise<RegistroAuditoria[]>;
  obtener(fuente: FuenteAuditoria, id: number): Promise<RegistroAuditoria | null>;
  /**
   * Traslada a las tablas de archivo los registros con más de `dias` días en una sola
   * transacción: copia y después elimina solo lo copiado. Devuelve cuántos movió por fuente.
   */
  archivar(dias: number): Promise<ConteoArchivado>;
}

export interface DependenciasAuditoria {
  repositorio: RepositorioAuditoria;
  /** Registro de las acciones sobre la propia auditoría (exportación y retención) */
  auditoria: PuertoAuditoria;
  /** Fecha local de hoy (AAAA-MM-DD) para el nombre del archivo exportado */
  hoy: () => string;
}

const ENTIDAD = 'auditoria';

/**
 * El texto de búsqueda llega tal como se escribió: antes de guardarlo en la auditoría se quitan los
 * caracteres de control y los saltos de línea (no se pueden inyectar líneas falsas en el registro).
 */
// eslint-disable-next-line no-control-regex
const textoAuditable = (q: string) => q.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();

const describirFiltros = (f: FiltrosAuditoria) => [
  f.q && textoAuditable(f.q) ? `texto "${textoAuditable(f.q)}"` : '',
  f.desde ? `desde ${f.desde.toISOString()}` : '',
  f.hasta ? `hasta ${f.hasta.toISOString()}` : '',
  f.exito === null ? '' : f.exito ? 'exitosos' : 'fallidos',
].filter(Boolean).join(', ');

export function casosAuditoria(d: DependenciasAuditoria) {
  return {
    async consultar(consulta: Record<string, unknown>) {
      const filtros = leerFiltrosAuditoria(consulta);
      const { pagina, tamano } = leerPaginacion(consulta);
      const total = await d.repositorio.contar(filtros);
      const items = await d.repositorio.pagina(filtros, (pagina - 1) * tamano, tamano);
      return { items, total, pagina, tamano };
    },

    /** CSV con las columnas completas de la fuente y los mismos filtros del listado. */
    async exportar(consulta: Record<string, unknown>, actor: Actor) {
      const filtros = leerFiltrosAuditoria(consulta);
      const filas = await d.repositorio.completos(filtros, MAX_FILAS_EXPORTACION);
      const contenido = generarCsv(CAMPOS_AUDITORIA[filtros.fuente], filas);
      const criterios = describirFiltros(filtros);
      await d.auditoria.operacion(actor, 'AUDITORIA_EXPORTADA', ENTIDAD, null,
        `${filtros.fuente} · ${filas.length} registros${criterios ? ` · ${criterios}` : ''}`);
      return { nombre: `auditoria_${filtros.fuente}_${d.hoy()}.csv`, contenido, registros: filas.length };
    },

    async obtener(fuente: unknown, id: unknown) {
      const f = String(fuente ?? '').toLowerCase();
      if (!esFuenteAuditoria(f)) throw errorValidacion('Fuente de auditoría inválida.');
      const i = validarIdAuditoria(id);
      if (!i.ok) throw errorValidacion(i.error);
      const registro = await d.repositorio.obtener(f, i.valor);
      if (!registro) throw errorNoEncontrado('Registro de auditoría no encontrado.');
      return registro;
    },

    /** Archiva lo que supera el plazo (365 a 3650 días) y deja constancia de cuánto movió. */
    async aplicarRetencion(dias: unknown, actor: Actor) {
      const v = validarDiasRetencion(dias);
      if (!v.ok) throw errorValidacion(v.error);
      const archivados = await d.repositorio.archivar(v.valor);
      await d.auditoria.operacion(actor, 'AUDITORIA_RETENCION', ENTIDAD, null,
        `Registros con más de ${v.valor} días archivados: ${archivados.operaciones} operaciones, `
        + `${archivados.cuentas} cuentas, ${archivados.accesos} accesos`);
      return { archivados };
    },
  };
}

export type CasosAuditoria = ReturnType<typeof casosAuditoria>;
