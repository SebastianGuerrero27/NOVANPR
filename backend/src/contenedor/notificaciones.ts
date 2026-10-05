import { casosNotificaciones } from '../aplicacion/notificaciones';
import { repositorioNotificacionesSql } from '../infraestructura/persistencia/notificacionesSql';
import { config } from '../infraestructura/servicios/configuracion';
import { clavePublicaVapid, enviarPush, webPushHabilitado } from '../infraestructura/servicios/webPush';

/** Raíz de composición de la bandeja de notificaciones: SQL Server y canal Web Push (VAPID). */
export const notificaciones = casosNotificaciones({
  repositorio: repositorioNotificacionesSql,
  push: { habilitado: webPushHabilitado, clavePublica: clavePublicaVapid, enviar: enviarPush },
  pushActivado: () => config.booleano('notif_push_habilitado'),
});
