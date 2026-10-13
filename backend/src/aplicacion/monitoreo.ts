import {
  type Actor, errorConflicto, errorNoEncontrado, errorValidacion, type PuertoAuditoria, type PuertoEventos,
} from './comun';
import type { PuertoMotorAnpr, PuertoServidorVideo, PuertoTickets, RepositorioCamaras } from './camaras';
import { leerAlcance, leerIdCamara, parsearExclusiones, parsearRoi } from '../dominio/camaras';

/**
 * Casos de uso del monitoreo en vivo:
 *
 *   estado()                 estado del motor ANPR y la cámara que procesa realmente
 *   cambiarCamara(id, actor) elige la cámara que procesa el motor (queda en la auditoría)
 *   ticket(alcance, actor)   credencial de 60 s para el video (WebRTC o WebSocket del motor)
 *
 * El motor no se conecta directo a la cámara: lee su ruta cam_<id> de MediaMTX, que comparte
 * una sola conexión con la cámara entre el motor y los navegadores.
 */

export interface DependenciasMonitoreo {
  repositorio: Pick<RepositorioCamaras, 'conexion'>;
  motor: PuertoMotorAnpr;
  video: Pick<PuertoServidorVideo, 'rutaCamara' | 'urlLecturaMotor' | 'urlWebrtc' | 'sincronizarRutas'>;
  tickets: Pick<PuertoTickets, 'emitir'>;
  auditoria: PuertoAuditoria;
  eventos: PuertoEventos;
}

/** Valor por omisión si la consulta falla (el estado del monitoreo nunca debe caerse por ella). */
async function intentar<T>(consulta: () => Promise<T>, omision: T): Promise<T> {
  try {
    return await consulta();
  } catch {
    return omision;
  }
}

export function casosMonitoreo(d: DependenciasMonitoreo) {
  return {
    /**
     * La cámara activa se informa solo si el motor procesa realmente la ruta de la cámara
     * registrada; si procesa otra fuente (p. ej. la RTSP_URL de su .env) se marca `fuente_externa`.
     */
    async estado() {
      const estado = await d.motor.estado();
      if (!estado.en_linea) return estado;
      const deseada = await intentar(() => d.motor.camaraDeseada(), null);
      const procesa = await intentar(() => d.motor.procesa(deseada), false);
      return {
        ...estado,
        camara_activa: procesa && deseada ? { id: deseada.id, conectada: Boolean(estado.camara_activa?.conectada) } : null,
        fuente_externa: !procesa,
      };
    },

    /** Cambia la cámara que procesa el motor; devuelve la cámara asignada. */
    async cambiarCamara(camaraId: unknown, actor: Actor) {
      const id = leerIdCamara(camaraId, true);
      if (!id.ok || id.valor === null) throw errorValidacion('Seleccione una cámara.');
      const c = await d.repositorio.conexion(id.valor);
      if (!c) throw errorNoEncontrado('Cámara no encontrada.');
      if (!c.activa) throw errorConflicto('La cámara está deshabilitada.');
      await d.motor.guardarCamara(c.id, actor.id);
      await d.video.sincronizarRutas();
      // Con sus zonas: si no, el motor analizaría el cuadro completo hasta la próxima sincronización
      await d.motor.cambiarCamara({
        id: c.id, nombre: c.nombre, rtsp_url: d.video.urlLecturaMotor(d.video.rutaCamara(c.id)),
        roi: parsearRoi(c.roi), exclusiones: parsearExclusiones(c.exclusiones),
      }, true);
      await d.auditoria.operacion(actor, 'MONITOREO_CAMARA', 'camara', c.id, `Motor ANPR procesando ${c.nombre}`);
      d.eventos.emitir('monitoreo:camara', { camara_id: c.id, nombre: c.nombre, por: actor.nombre });
      return { id: c.id, nombre: c.nombre };
    },

    /** Ticket de 60 s para ver el video de las cámaras registradas y las pistas del motor. */
    ticket(alcanceSolicitado: unknown, actor: Actor) {
      const alcance = leerAlcance(alcanceSolicitado);
      if (!alcance.ok) throw errorValidacion(alcance.error);
      return { ticket: d.tickets.emitir(actor.id, alcance.valor), url: d.motor.urlPublica(), webrtc: d.video.urlWebrtc() };
    },
  };
}

export type CasosMonitoreo = ReturnType<typeof casosMonitoreo>;
