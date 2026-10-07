import { casosListas } from '../aplicacion/listas';
import { describirHorario } from '../dominio/horario';
import { auditoriaSql, eventosSocket } from '../infraestructura/adaptadores';
import { repositorioListasSql } from '../infraestructura/persistencia/listasSql';
import { notificarPermisoOtorgado } from '../infraestructura/servicios/avisosAcceso';

/**
 * Raíz de composición (un archivo por módulo en src/contenedor/): el único lugar donde los
 * casos de uso se conectan con sus implementaciones concretas (SQL Server, Socket.IO,
 * notificaciones). Las pruebas construyen los casos de uso con dobles de prueba en su lugar.
 */
export const listas = casosListas({
  repositorio: repositorioListasSql,
  auditoria: auditoriaSql,
  eventos: eventosSocket,
  describirHorario,
  avisos: {
    registroAgregado(def, registro, actor) {
      // Vehículo agregado a la lista blanca: la garita recibe la notificación
      if (def.tipo === 'autorizados') void notificarPermisoOtorgado(registro as any, { id: actor.id, nombre: actor.nombre });
    },
  },
});
