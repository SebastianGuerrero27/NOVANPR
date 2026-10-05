import { casosAuditoria } from '../aplicacion/auditoria';
import { tiempoLocal } from '../dominio/horario';
import { auditoriaSql } from '../infraestructura/adaptadores';
import { repositorioAuditoriaSql } from '../infraestructura/persistencia/auditoriaSql';
import { ZONA_HORARIA } from '../infraestructura/servicios/tiempo';

/**
 * Raíz de composición de la auditoría: consultas y retención sobre SQL Server; la exportación y
 * la retención se registran a su vez en AuditoriaOperaciones (adaptador de solo inserción).
 */
export const auditoria = casosAuditoria({
  repositorio: repositorioAuditoriaSql,
  auditoria: auditoriaSql,
  // Fecha local de la institución para el nombre del archivo exportado (AAAA-MM-DD)
  hoy: () => tiempoLocal(new Date(), ZONA_HORARIA).ymd,
});
