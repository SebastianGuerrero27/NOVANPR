import { casosDetecciones, type DeteccionDTO } from '../aplicacion/detecciones';
import { getDB } from '../infraestructura/db';
import { auditoriaSql, eventosSocket } from '../infraestructura/adaptadores';
import { repositorioDeteccionesSql } from '../infraestructura/persistencia/deteccionesSql';
import { presentarDeteccion } from '../infraestructura/presentacionDetecciones';
import { notificarDecision, type PasoNotificable } from '../infraestructura/servicios/avisosAcceso';
import { politicaAutorizacion } from '../infraestructura/servicios/configuracion';
import { eliminarEvidencia } from '../infraestructura/servicios/media';
import { resolverPorDeteccion } from '../infraestructura/servicios/notificaciones';
import { findBlacklistMatch, findPermisoExacto } from '../infraestructura/servicios/plateMatching';
import { ZONA_HORARIA } from '../infraestructura/servicios/tiempo';
import { compararVehiculo } from '../dominio/vehiculoAtributos';

/**
 * Raíz de composición de las detecciones: SQL Server, cruce con las listas, evidencia en disco,
 * difusión por Socket.IO, centro de notificaciones y auditoría.
 */
export const detecciones = casosDetecciones({
  repositorio: repositorioDeteccionesSql,
  listas: {
    alerta: placa => findBlacklistMatch(getDB(), placa),
    permiso: placa => findPermisoExacto(getDB(), placa),
  },
  presentar: presentarDeteccion,
  politica: politicaAutorizacion,
  compararVehiculo: (registrado, observado) => compararVehiculo(registrado, observado),
  avisos: {
    // Sin esperar: un fallo de notificación no interrumpe el registro del paso
    decision: (dto: DeteccionDTO, decision, permiso) => { void notificarDecision(dto as unknown as PasoNotificable, decision, permiso); },
    resolverPorDeteccion,
  },
  evidencia: { eliminar: eliminarEvidencia },
  eventos: eventosSocket,
  auditoria: auditoriaSql,
  tiempo: { ahora: () => new Date(), zona: ZONA_HORARIA },
});
