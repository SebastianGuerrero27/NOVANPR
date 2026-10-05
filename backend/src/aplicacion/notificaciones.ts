import { type Actor, errorNoDisponible, errorNoEncontrado, errorValidacion } from './comun';
import { CATALOGO, type ConsultaBandeja, leerConsultaBandeja, leerDiasMetricas } from '../dominio/notificaciones';
import { leerSuscripcionPush, type SuscripcionPush } from '../dominio/suscripcionPush';

/**
 * Bandeja de notificaciones de la sesión (cada usuario ve solo las suyas), reconocimiento (ACK)
 * de alarmas, canal Web Push del navegador y métricas del canal para la evaluación científica
 * (ISA-18.2: tiempo de reconocimiento por prioridad, tasa de alarmas por hora y avalanchas).
 *
 * La creación, el agrupamiento y el escalamiento de las notificaciones están en
 * infraestructura/servicios/notificaciones.ts (los usan la detección y las tareas programadas).
 */

export type Fila = Record<string, any>;

export interface ResumenNotificaciones {
  no_leidas: number;
  pendientes: number;
}

/** Suscripción push guardada (con su id y su usuario). */
export interface SuscripcionGuardada {
  id: number;
  usuario_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface RepositorioNotificaciones {
  /** Notificaciones del usuario ya representadas para la API, de la más reciente a la más antigua */
  bandeja(usuarioId: number, c: ConsultaBandeja): Promise<unknown[]>;
  resumen(usuarioId: number): Promise<ResumenNotificaciones>;
  leerTodas(usuarioId: number): Promise<void>;
  leer(usuarioId: number, id: number): Promise<void>;
  /** Reconocimiento de una alarma o de las alarmas de un paso vehicular; devuelve cuántas */
  reconocer(usuarioId: number, filtro: { id?: number; deteccionId?: number }): Promise<number>;
  /** Un mismo navegador puede pasar a otra cuenta: la suscripción se reasigna al usuario actual */
  guardarSuscripcion(usuarioId: number, s: SuscripcionPush, agente: string): Promise<void>;
  eliminarSuscripcion(usuarioId: number, endpoint: string): Promise<void>;
  suscripciones(usuarioId: number): Promise<SuscripcionGuardada[]>;
  eliminarSuscripciones(ids: number[]): Promise<void>;
  metricas(dias: number): Promise<{ porSeveridad: Fila[]; tta: Fila[]; avalanchas?: Fila }>;
}

export interface MensajePush {
  id: number;
  tipo: string;
  severidad: string;
  titulo: string;
  mensaje: string;
  enlace: string | null;
}

/** Canal Web Push (infraestructura/servicios/webPush.ts): claves VAPID del servidor y envío. */
export interface PuertoPush {
  habilitado(): boolean;
  clavePublica(): string | null;
  enviar(subs: SuscripcionGuardada[], mensaje: MensajePush, opciones: { ttlS: number; urgencia: 'very-low' | 'low' | 'normal' | 'high' }):
    Promise<{ enviados: number; vencidas: number[]; fallidas: number[] }>;
}

export interface DependenciasNotificaciones {
  repositorio: RepositorioNotificaciones;
  push: PuertoPush;
  /** Parámetro notif_push_habilitado de la configuración */
  pushActivado: () => boolean;
}

export function casosNotificaciones(d: DependenciasNotificaciones) {
  const resumen = (actor: Actor) => d.repositorio.resumen(actor.id);

  return {
    async bandeja(actor: Actor, consulta: Parameters<typeof leerConsultaBandeja>[0]) {
      const c = leerConsultaBandeja(consulta);
      if (!c.ok) throw errorValidacion(c.error);
      return { items: await d.repositorio.bandeja(actor.id, c.valor), ...(await resumen(actor)) };
    },

    resumen,

    catalogo: () => Object.entries(CATALOGO).map(([tipo, t]) => ({
      tipo, etiqueta: t.etiqueta, severidad: t.severidad, requiere_ack: t.requiereAck, push: t.push, permiso: t.permiso ?? null,
    })),

    async leerTodas(actor: Actor) {
      await d.repositorio.leerTodas(actor.id);
      return { message: 'Notificaciones marcadas como leídas.', ...(await resumen(actor)) };
    },

    async leer(actor: Actor, id: number) {
      await d.repositorio.leer(actor.id, id);
      return resumen(actor);
    },

    async reconocer(actor: Actor, id: number) {
      const reconocidas = await d.repositorio.reconocer(actor.id, { id });
      return { reconocidas, ...(await resumen(actor)) };
    },

    /** Botón "Enterado" del aviso de garita: reconoce las alarmas de un paso vehicular. */
    async reconocerDeteccion(actor: Actor, deteccionId: number) {
      const reconocidas = await d.repositorio.reconocer(actor.id, { deteccionId });
      return { reconocidas, ...(await resumen(actor)) };
    },

    clavePush: () => ({ habilitado: d.push.habilitado() && d.pushActivado(), clave_publica: d.push.clavePublica() }),

    async suscribir(actor: Actor, cuerpo: unknown, agente: unknown) {
      const s = leerSuscripcionPush(cuerpo);
      if (!s.ok) throw errorValidacion(s.error);
      await d.repositorio.guardarSuscripcion(actor.id, s.valor, String(agente ?? '').substring(0, 255));
      return { message: 'Notificaciones del navegador activadas en este equipo.' };
    },

    async desuscribir(actor: Actor, cuerpo: unknown) {
      const endpoint = (cuerpo as { endpoint?: unknown } | null | undefined)?.endpoint;
      if (typeof endpoint !== 'string' || !endpoint) throw errorValidacion('Indique la suscripción.');
      await d.repositorio.eliminarSuscripcion(actor.id, endpoint);
      return { message: 'Notificaciones del navegador desactivadas en este equipo.' };
    },

    /** Push de prueba a los equipos del usuario; las suscripciones vencidas se eliminan. */
    async probarPush(actor: Actor) {
      if (!d.push.habilitado()) throw errorNoDisponible('El canal push no está disponible en el servidor.');
      const subs = await d.repositorio.suscripciones(actor.id);
      if (!subs.length) throw errorNoEncontrado('Este usuario no tiene equipos suscritos.');
      const r = await d.push.enviar(subs, {
        id: 0, tipo: 'prueba', severidad: 'baja', titulo: 'Prueba de notificaciones',
        mensaje: 'Las notificaciones del Sistema ANPR llegan a este equipo.', enlace: '/notificaciones',
      }, { ttlS: 60, urgencia: 'normal' });
      if (r.vencidas.length) await d.repositorio.eliminarSuscripciones(r.vencidas);
      return { message: `Prueba enviada a ${r.enviados} ${r.enviados === 1 ? 'equipo' : 'equipos'}.`, ...r };
    },

    /**
     * Tiempo de reconocimiento (TTA) por prioridad (mediana y p95), tasa de alarmas por hora y
     * ventanas de avalancha (> 10 alarmas críticas o altas en 10 min, ISA-18.2).
     */
    async metricas(consulta: { dias?: unknown }) {
      const dias = leerDiasMetricas(consulta.dias);
      if (!dias.ok) throw errorValidacion(dias.error);
      const r = await d.repositorio.metricas(dias.valor);
      const filas = r.porSeveridad.map(f => {
        const t = r.tta.find(x => x.severidad === f.severidad);
        return {
          severidad: f.severidad,
          emitidas: Number(f.emitidas), repeticiones_agrupadas: Number(f.repeticiones_agrupadas ?? 0),
          con_ack: Number(f.con_ack), reconocidas: Number(f.reconocidas), escaladas: Number(f.escaladas),
          tta_mediana_s: t ? Number(t.tta_mediana_s) : null, tta_p95_s: t ? Number(t.tta_p95_s) : null,
        };
      });
      const total = filas.reduce((a, f) => a + f.emitidas, 0);
      return {
        dias: dias.valor, por_severidad: filas,
        alarmas_por_hora: total / (dias.valor * 24),
        ventanas_avalancha_10min: Number(r.avalanchas?.ventanas_avalancha ?? 0),
      };
    },
  };
}

export type CasosNotificaciones = ReturnType<typeof casosNotificaciones>;
