import { errorValidacion } from './comun';
import type { CalendarioLocal } from './calendario';
import { leerPeriodoReporte, type PeriodoReporte } from '../dominio/periodo';

/**
 * Reporte consolidado de un período (solo lectura): totales, series por día y por hora, cámaras,
 * tipos de vehículo, placas frecuentes, validaciones por usuario y alertas.
 *
 * Sin fechas, los últimos 7 días locales; máximo un año por consulta (dominio/periodo.ts). Las
 * agregaciones se calculan en la base; aquí se valida el período, se completa la serie diaria
 * (los días sin registros aparecen con cero) y los conteos se entregan como números.
 */

/** Fila tal como la entrega la base. */
export type Fila = Record<string, any>;

export interface DatosReporte {
  /** Conteos, validados, manuales, placas distintas, latencia y confianza medias */
  totales: Fila;
  /** Conteos por día local ({ fecha, …conteos }) */
  porDia: Fila[];
  /** { hora, total } por hora local */
  porHora: Fila[];
  porCamara: Fila[];
  porTipo: Fila[];
  frecuentes: Fila[];
  validacion: Fila[];
  alertas: Fila[];
}

export interface RepositorioReportes {
  /** `desfase`: minutos de la zona local, para agrupar por día y por hora locales */
  consolidado(p: PeriodoReporte, desfase: number): Promise<DatosReporte>;
}

export interface DependenciasReportes {
  repositorio: RepositorioReportes;
  tiempo: CalendarioLocal;
}

const DIA_MS = 86_400_000;
const CAMPOS_SERIE = ['total', 'autorizados', 'alertas', 'no_registrados', 'pendientes'] as const;

/** Valores numéricos de la fila (los nulos de un SUM sin registros valen 0); el texto se conserva. */
const numeros = (fila?: Fila): Fila =>
  Object.fromEntries(Object.entries(fila ?? {}).map(([k, v]) => [k, typeof v === 'number' || v === null ? Number(v ?? 0) : v]));

export function casosReportes(d: DependenciasReportes) {
  return {
    async consolidado(consulta: { desde?: unknown; hasta?: unknown; camara?: unknown }) {
      const ahora = d.tiempo.ahora();
      const periodo = leerPeriodoReporte(consulta, { desde: d.tiempo.inicioDiaLocal(ahora, -6), hasta: ahora });
      if (!periodo.ok) throw errorValidacion(periodo.error);
      const { desde, hasta, camara } = periodo.valor;
      const desfase = d.tiempo.desfaseMinutos(ahora);
      const r = await d.repositorio.consolidado(periodo.valor, desfase);

      // Serie diaria continua: los días sin registros aparecen con cero
      const porDia: Fila[] = [];
      for (let t = d.tiempo.inicioDiaLocal(desde); t <= hasta; t = new Date(t.getTime() + DIA_MS)) {
        const fecha = new Date(t.getTime() + desfase * 60000).toISOString().slice(0, 10);
        const f = r.porDia.find(x => new Date(x.fecha).toISOString().slice(0, 10) === fecha);
        porDia.push({ fecha, ...Object.fromEntries(CAMPOS_SERIE.map(c => [c, Number(f?.[c] ?? 0)])) });
      }

      return {
        periodo: { desde, hasta, camara },
        totales: { ...numeros(r.totales), latencia_media_ms: r.totales.latencia_media_ms, confianza_ocr_media: r.totales.confianza_ocr_media },
        por_dia: porDia,
        por_hora: Array.from({ length: 24 }, (_, h) => ({ hora: h, total: Number(r.porHora.find(x => x.hora === h)?.total ?? 0) })),
        por_camara: r.porCamara.map(f => numeros(f)),
        por_tipo: r.porTipo.map(f => numeros(f)),
        placas_frecuentes: r.frecuentes,
        validacion_por_usuario: r.validacion.map(f => numeros(f)),
        alertas: r.alertas,
      };
    },
  };
}

export type CasosReportes = ReturnType<typeof casosReportes>;
