import {
  casosCamaras, type PuertoConectividad, type PuertoMotorAnpr, type PuertoServidorVideo, type PuertoTickets,
} from '../aplicacion/camaras';
import { casosMedios } from '../aplicacion/medios';
import { casosMonitoreo } from '../aplicacion/monitoreo';
import { auditoriaSql, eventosSocket } from '../infraestructura/adaptadores';
import { repositorioCamarasSql } from '../infraestructura/persistencia/camarasSql';
import { camaraDeseada, guardarCamaraMotor, motorProcesa, sincronizarCamaraMotor } from '../infraestructura/servicios/camaraMotor';
import { destinoRtsp, diagnosticar, probarConexion, registrarConexion } from '../infraestructura/servicios/conectividadCamaras';
import { custodiaCredenciales } from '../infraestructura/servicios/custodiaCredenciales';
import {
  camaraDeRuta, crearRutaPrueba, eliminarRutaPrueba, emitirTicket, esMotor, estadoRuta, rutaCamara, rutaVista, sincronizarRutas,
  ticketValido, urlLecturaMotor, urlWebrtcPublica,
} from '../infraestructura/servicios/medios';
import { cambiarCamaraAnpr, estadoServicioAnpr, fijarZonasAnpr, urlPublicaAnpr } from '../infraestructura/servicios/servicioAnpr';
import { verificarRed } from '../infraestructura/servicios/redCamaras';

/**
 * Raíz de composición del módulo de cámaras, monitoreo y medios: conecta los casos de uso con
 * los adaptadores existentes (SQL Server, diagnóstico RTSP/ICMP, MediaMTX, motor ANPR,
 * custodia de credenciales AES-256-GCM y Socket.IO). Las pruebas construyen los casos de uso con dobles en su lugar.
 */

const conectividad: PuertoConectividad = {
  destino: destinoRtsp,
  probar: probarConexion,
  diagnosticar,
  verificarRed: (rtsp, ip) => verificarRed(rtsp, ip),
  registrar: registrarConexion,
};

const video: PuertoServidorVideo = {
  rutaCamara,
  rutaVista,
  urlLecturaMotor,
  urlWebrtc: urlWebrtcPublica,
  sincronizarRutas,
  crearRutaPrueba,
  eliminarRutaPrueba,
  estadoRuta,
  camaraDeRuta,
};

const tickets: PuertoTickets = { emitir: emitirTicket, valido: ticketValido, esMotor };

const motor: PuertoMotorAnpr = {
  estado: estadoServicioAnpr,
  camaraDeseada,
  procesa: motorProcesa,
  guardarCamara: guardarCamaraMotor,
  cambiarCamara: cambiarCamaraAnpr,
  fijarZonas: fijarZonasAnpr,
  sincronizar: () => sincronizarCamaraMotor(),
  urlPublica: urlPublicaAnpr,
};

const comunes = { repositorio: repositorioCamarasSql, video, tickets, motor, auditoria: auditoriaSql, eventos: eventosSocket };

export const camaras = casosCamaras({ ...comunes, conectividad, custodia: custodiaCredenciales });
export const monitoreo = casosMonitoreo(comunes);
export const medios = casosMedios({ video, tickets });
