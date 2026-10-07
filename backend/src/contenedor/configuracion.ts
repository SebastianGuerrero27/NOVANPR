import { casosConfiguracion } from '../aplicacion/configuracion';
import { auditoriaSql } from '../infraestructura/adaptadores';
import { entornoSistema } from '../infraestructura/entornoSistema';
import { repositorioConfiguracionSql } from '../infraestructura/persistencia/configuracionSql';

/** Raíz de composición de la configuración del sistema: parámetros en SQL Server y entorno del servidor. */
export const configuracion = casosConfiguracion({
  repositorio: repositorioConfiguracionSql,
  entorno: entornoSistema,
  auditoria: auditoriaSql,
});
