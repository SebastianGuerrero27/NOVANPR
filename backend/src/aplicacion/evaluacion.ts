import { errorValidacion } from './comun';
import { calcularEvaluacion, csvEvaluacion, type FilaExportacionEvaluacion } from '../dominio/evaluacion';
import { type FiltroEvaluacion, leerFiltroEvaluacion } from '../dominio/periodo';

/**
 * Evaluación científica del reconocimiento con datos de operación (solo lectura): métricas con
 * intervalos de confianza (dominio/evaluacion.ts) y exportación CSV de los pasos para el
 * análisis estadístico (services/anpr/scripts/estadistica.py).
 *
 * El filtro (días AAAA-MM-DD inclusivos y una cámara) se valida antes de consultar la base.
 */

export interface RepositorioEvaluacion {
  /** Pasos con lectura terminada (no pendientes de OCR) dentro del filtro, en orden cronológico */
  pasos(f: FiltroEvaluacion): Promise<FilaExportacionEvaluacion[]>;
}

export interface DependenciasEvaluacion {
  repositorio: RepositorioEvaluacion;
}

type ConsultaEvaluacion = { desde?: unknown; hasta?: unknown; camara_id?: unknown };

export function casosEvaluacion(d: DependenciasEvaluacion) {
  const filtro = (consulta: ConsultaEvaluacion): FiltroEvaluacion => {
    const f = leerFiltroEvaluacion(consulta);
    if (!f.ok) throw errorValidacion(f.error);
    return f.valor;
  };

  return {
    /** Métricas sobre los pasos validados por el personal; la cobertura usa el total del período. */
    async resumen(consulta: ConsultaEvaluacion) {
      const f = filtro(consulta);
      const pasos = await d.repositorio.pasos(f);
      const validados = pasos.filter(p => p.validado_manualmente);
      const modelos = [...new Set(pasos.map(p => `${p.modelo_detector ?? '?'} + ${p.modelo_ocr ?? '?'}`))];
      return { periodo: { desde: f.desde, hasta: f.hasta }, modelos, ...calcularEvaluacion(validados, pasos.length) };
    },

    /** CSV con una fila por paso vehicular del filtro. */
    async exportar(consulta: ConsultaEvaluacion) {
      return csvEvaluacion(await d.repositorio.pasos(filtro(consulta)));
    },
  };
}

export type CasosEvaluacion = ReturnType<typeof casosEvaluacion>;
