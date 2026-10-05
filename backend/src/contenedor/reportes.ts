import { casosReportes } from '../aplicacion/reportes';
import { calendarioLocal } from '../infraestructura/calendarioLocal';
import { repositorioReportesSql } from '../infraestructura/persistencia/reportesSql';

/** Raíz de composición del reporte consolidado: agregaciones en SQL Server y calendario local. */
export const reportes = casosReportes({ repositorio: repositorioReportesSql, tiempo: calendarioLocal });
