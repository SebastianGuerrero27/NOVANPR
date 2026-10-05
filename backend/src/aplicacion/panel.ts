import type { Actor } from './comun';
import type { CalendarioLocal } from './calendario';
import { ROL_POR_CODIGO, ROLES } from '../dominio/permisos';

/**
 * Casos de uso del panel de inicio (solo lectura). Los indicadores se calculan en la base con
 * los registros reales: si no hay detecciones valen cero (no hay datos de relleno). Aquí se
 * completan las series (24 horas de hoy y 7 días de tendencia), se convierten los conteos y se
 * agrupan las cuentas del personal por estado y rol.
 *
 *   resumen()          operación del día y de los últimos 7 días
 *   accesos(actor)     solicitudes, padrón, accesos denegados y placas reincidentes
 *   administracion()   cuentas, accesos, actividad y estado de los servicios
 */

/** Fila tal como la entrega la base (conteos, detecciones, cámaras…). */
export type Fila = Record<string, any>;

export interface ParametrosOperacion {
  hoy: Date;
  ayer: Date;
  hace7: Date;
  mismaHoraAyer: Date;
  /** Desfase de la zona local en minutos (agrupación por hora y por día local) */
  desfase: number;
  /** Días de anticipación del aviso de vencimiento de permisos */
  diasAviso: number;
}

export interface DatosOperacion {
  /** Conteos de hoy: total, autorizados, alertas, no_registrados, pendientes, validados */
  hoy?: Fila;
  /** { total } de ayer hasta la misma hora */
  ayer?: Fila;
  /** Conteos por hora local de hoy ({ hora, …conteos }) */
  porHora: Fila[];
  /** Conteos por día local de los últimos 7 días ({ fecha, …conteos }) */
  tendencia: Fila[];
  camaras: Fila[];
  /** { n }: pasos pendientes de revisión manual */
  cola?: Fila;
  /** Últimas detecciones de placas en la lista negra (filas de DeteccionVehiculo) */
  alertas: Fila[];
  /** Vigentes, por vencer y vencidos de las listas de control */
  listas?: Fila;
  /** { validadas, correctas }: lectura automática frente a lo confirmado por el personal (7 días) */
  precision?: Fila;
}

export interface ParametrosAccesos {
  hoy: Date;
  hace7: Date;
  diasAviso: number;
  /** Separación de funciones: las solicitudes propias no son trabajo pendiente de quien las registró */
  usuarioId: number;
}

export interface DatosAccesos {
  /** Últimas solicitudes pendientes de otros usuarios; cada fila trae el `total` de pendientes */
  solicitudes: Fila[];
  padron?: Fila;
  /** { categoria, n } de los permisos activos */
  categorias: Fila[];
  /** { sin_permiso, restringidos } de hoy */
  denegados?: Fila;
  /** { placa, intentos, ultimo } con dos o más intentos sin permiso en 7 días */
  reincidentes: Fila[];
  /** Pasos denegados recientes (filas de DeteccionVehiculo) */
  recientes: Fila[];
}

export interface DatosAdministracion {
  /** Cuentas agrupadas por { codigo, estado, bloqueado, bloqueo_temporal, n } */
  usuarios: Fila[];
  /** { exitosos, fallidos } de las últimas 24 horas */
  accesos?: Fila;
  fallidos: Fila[];
  actividad: Fila[];
}

export interface RepositorioPanel {
  operacion(p: ParametrosOperacion): Promise<DatosOperacion>;
  accesos(p: ParametrosAccesos): Promise<DatosAccesos>;
  administracion(): Promise<DatosAdministracion>;
}

/** Estado de los servicios externos que muestra el panel de administración. */
export interface PuertoServicios {
  anpr(): Promise<unknown>;
  correoConfigurado(): boolean;
}

export interface DependenciasPanel {
  repositorio: RepositorioPanel;
  tiempo: CalendarioLocal;
  diasAviso: () => number;
  /** Representación de una detección para la API (la misma del historial y del tiempo real) */
  mapearDeteccion: (fila: Fila) => unknown;
  servicios: PuertoServicios;
}

const DIA_MS = 86_400_000;
const CAMPOS_SERIE = ['total', 'autorizados', 'alertas', 'no_registrados', 'pendientes'] as const;

/** Valores numéricos de una fila de conteos; los nulos (SUM sin filas) valen 0. */
const cero = (fila?: Fila): Record<string, number> =>
  Object.fromEntries(Object.entries(fila ?? {}).map(([k, v]) => [k, Number(v ?? 0)]));

/** Conteos de un punto de la serie (hora o día); sin registros, todos en cero. */
const conteosSerie = (fila?: Fila) =>
  Object.fromEntries(CAMPOS_SERIE.map(c => [c, Number(fila?.[c] ?? 0)])) as Record<typeof CAMPOS_SERIE[number], number>;

/** Día calendario (AAAA-MM-DD) de una columna DATE. */
const diaDe = (fecha: string | number | Date) => new Date(fecha).toISOString().slice(0, 10);

export function casosPanel(d: DependenciasPanel) {
  return {
    async resumen() {
      const ahora = d.tiempo.ahora();
      const desfase = d.tiempo.desfaseMinutos(ahora);
      const diasAviso = d.diasAviso();
      const r = await d.repositorio.operacion({
        hoy: d.tiempo.inicioDiaLocal(ahora),
        ayer: d.tiempo.inicioDiaLocal(ahora, -1),
        hace7: d.tiempo.inicioDiaLocal(ahora, -6),
        mismaHoraAyer: new Date(ahora.getTime() - DIA_MS),
        desfase,
        diasAviso,
      });

      // Series completas: las horas y los días sin registros aparecen con cero
      const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, ...conteosSerie(r.porHora.find(x => Number(x.hora) === h)) }));
      const tendencia = Array.from({ length: 7 }, (_, i) => {
        const inicio = d.tiempo.inicioDiaLocal(ahora, i - 6);
        const fecha = new Date(inicio.getTime() + desfase * 60000).toISOString().slice(0, 10);
        return { fecha, ...conteosSerie(r.tendencia.find(x => diaDe(x.fecha) === fecha)) };
      });

      return {
        generado: ahora,
        hoy: cero(r.hoy),
        ayer_misma_hora: Number(r.ayer?.total ?? 0),
        por_hora: porHora,
        tendencia,
        camaras: r.camaras.map(c => ({ ...c, activa: Boolean(c.activa) })),
        cola_revision: Number(r.cola?.n ?? 0),
        ultimas_alertas: r.alertas.map(x => d.mapearDeteccion(x)),
        listas: { ...cero(r.listas), dias_aviso: diasAviso },
        exactitud_ocr: { validadas: Number(r.precision?.validadas ?? 0), correctas: Number(r.precision?.correctas ?? 0) },
      };
    },

    /** Panel del Gestor de permisos: base para registrar o investigar placas. */
    async accesos(actor: Actor) {
      const ahora = d.tiempo.ahora();
      const diasAviso = d.diasAviso();
      const r = await d.repositorio.accesos({
        hoy: d.tiempo.inicioDiaLocal(ahora),
        hace7: d.tiempo.inicioDiaLocal(ahora, -6),
        diasAviso,
        usuarioId: actor.id,
      });
      return {
        generado: ahora,
        solicitudes: {
          pendientes: Number(r.solicitudes[0]?.total ?? 0),
          ultimas: r.solicitudes.map(({ total: _total, ...s }) => s),
        },
        padron: { ...cero(r.padron), dias_aviso: diasAviso },
        categorias: Object.fromEntries(r.categorias.map(c => [c.categoria, Number(c.n)])),
        hoy: cero(r.denegados),
        reincidentes: r.reincidentes.map(x => ({ placa: x.placa, intentos: Number(x.intentos), ultimo: x.ultimo })),
        denegados_recientes: r.recientes.map(x => d.mapearDeteccion(x)),
      };
    },

    async administracion() {
      const [r, anpr] = await Promise.all([d.repositorio.administracion(), d.servicios.anpr()]);
      const porRol = Object.fromEntries(ROLES.map(rol => [rol, 0])) as Record<string, number>;
      const usuarios = { total: 0, activos: 0, pendientes: 0, inactivos: 0, bloqueados: 0, por_rol: porRol };
      for (const f of r.usuarios) {
        const n = Number(f.n);
        usuarios.total += n;
        // Un bloqueo (administrativo o temporal por intentos fallidos) prevalece sobre el estado
        if (f.bloqueado || f.bloqueo_temporal) usuarios.bloqueados += n;
        else if (f.estado === 'activo') usuarios.activos += n;
        else if (f.estado === 'pendiente') usuarios.pendientes += n;
        else usuarios.inactivos += n;
        const rol = ROL_POR_CODIGO[f.codigo];
        if (rol) usuarios.por_rol[rol] += n;
      }
      return {
        usuarios,
        accesos_24h: cero(r.accesos),
        ultimos_fallidos: r.fallidos,
        actividad: r.actividad,
        servicios: {
          base_datos: { en_linea: true },
          anpr,
          correo: { configurado: d.servicios.correoConfigurado() },
        },
      };
    },
  };
}

export type CasosPanel = ReturnType<typeof casosPanel>;
