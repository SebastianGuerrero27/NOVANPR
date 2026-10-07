import { casosPanel } from '../aplicacion/panel';
import { calendarioLocal } from '../infraestructura/calendarioLocal';
import { repositorioPanelSql } from '../infraestructura/persistencia/panelSql';
import { presentarDeteccion } from '../infraestructura/presentacionDetecciones';
import { config } from '../infraestructura/servicios/configuracion';
import { emailService } from '../infraestructura/servicios/emailService';
import { estadoServicioAnpr } from '../infraestructura/servicios/servicioAnpr';

/** Raíz de composición del panel de inicio: agregaciones en SQL Server, calendario local y estado de los servicios. */
export const panel = casosPanel({
  repositorio: repositorioPanelSql,
  tiempo: calendarioLocal,
  diasAviso: () => config.entero('aviso_vencimiento_dias'),
  // Misma representación de una detección que el historial y el tiempo real
  mapearDeteccion: fila => presentarDeteccion(fila),
  servicios: { anpr: estadoServicioAnpr, correoConfigurado: () => emailService.smtpConfigurado() },
});
