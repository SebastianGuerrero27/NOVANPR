import { type Actor, errorValidacion, type PuertoAuditoria } from './comun';
import { leerCambiosConfiguracion, type ReglaParametro } from '../dominio/configuracion';

/**
 * Casos de uso de la configuración del sistema: consultar los parámetros editables (valor
 * vigente y origen) con los datos del entorno, y guardar cambios. Cada valor se valida según el
 * tipo declarado del parámetro (dominio/configuracion.ts) antes de escribir nada; solo se
 * guardan y auditan los que cambian, y al final se recargan los valores en memoria.
 */

/** Parámetro tal como lo entrega la API: su definición, el valor vigente y su origen. */
export type ParametroDTO = ReglaParametro & { valor: string } & Record<string, unknown>;

export interface RepositorioConfiguracion {
  /** Definición (tipo, rango u opciones) de cada parámetro editable */
  definiciones(): readonly ReglaParametro[];
  /** Parámetros con el valor vigente y su origen (sistema, entorno u omisión) */
  listar(): ParametroDTO[];
  guardar(clave: string, valor: string, usuarioId: number): Promise<void>;
  /** Vuelve a leer los valores guardados: el resto del sistema los consulta en memoria */
  recargar(): Promise<void>;
}

/** Datos del entorno de ejecución que la pantalla muestra en modo de solo lectura. */
export interface PuertoEntorno {
  describir(): Promise<Record<string, unknown>>;
}

export interface DependenciasConfiguracion {
  repositorio: RepositorioConfiguracion;
  entorno: PuertoEntorno;
  auditoria: PuertoAuditoria;
}

export function casosConfiguracion(d: DependenciasConfiguracion) {
  return {
    async consultar() {
      const entorno = await d.entorno.describir();
      return { parametros: d.repositorio.listar(), entorno };
    },

    /** Guarda los valores que cambian (todos validados antes); devuelve cuántos y los parámetros vigentes. */
    async guardar(valores: unknown, actor: Actor) {
      const v = leerCambiosConfiguracion(d.repositorio.definiciones(), valores);
      if (!v.ok) throw errorValidacion(v.error);
      const previos = new Map(d.repositorio.listar().map(p => [p.clave, p.valor]));
      const cambiados = v.valor.filter(([clave, valor]) => previos.get(clave) !== valor);
      for (const [clave, valor] of cambiados) {
        await d.repositorio.guardar(clave, valor, actor.id);
        await d.auditoria.operacion(actor, 'CONFIGURACION', 'configuracion', null, `${clave}: ${previos.get(clave)} → ${valor}`);
      }
      await d.repositorio.recargar();
      return { cambiados: cambiados.length, parametros: d.repositorio.listar() };
    },
  };
}

export type CasosConfiguracion = ReturnType<typeof casosConfiguracion>;
