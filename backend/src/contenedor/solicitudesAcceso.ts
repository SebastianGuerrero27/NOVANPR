import { casosSolicitudes } from '../aplicacion/solicitudesAcceso';
import { auditoriaSql, eventosSocket } from '../infraestructura/adaptadores';
import { repositorioSolicitudesSql } from '../infraestructura/persistencia/solicitudesAccesoSql';
import { notificar } from '../infraestructura/servicios/notificaciones';
import { listas } from './listas';

/**
 * Raíz de composición de las solicitudes de acceso. La aprobación concede el permiso con los
 * casos de uso de listas (crear, reactivar o ampliar, difundir y anunciar el alta a la garita).
 */
export const solicitudes = casosSolicitudes({
  repositorio: repositorioSolicitudesSql,
  listas,
  auditoria: auditoriaSql,
  eventos: eventosSocket,
  // notificar() nunca lanza: guarda la notificación y la entrega por Socket.IO y Web Push
  avisos: { notificar: aviso => void notificar(aviso) },
});
