import {
  type Actor, errorConflicto, errorNoEncontrado, errorValidacion, type PuertoAuditoria, type PuertoEventos,
} from './comun';
import {
  type AlcanceTicket, type CamaraGuardada, type CamaraPublica, cambiosCamara, type DatosCamara, leerCamara, leerIdCamara,
  LARGO_MAXIMO_IP, leerIp, leerRoi, leerUrlRtsp, MASCARA, presentarCamara, type Punto, RE_RUTA_PRUEBA, RE_RUTA_VIDEO,
} from '../dominio/camaras';
import type { Validado } from '../dominio/validacion';

/**
 * Casos de uso de las cámaras (canales RTSP): consultar, ver detalle, registrar, editar,
 * habilitar o deshabilitar, fijar la región de interés, eliminar (solo sin historial),
 * diagnosticar la conectividad y reproducir el video por WebRTC.
 *
 * Todo cambio queda en la auditoría y se difunde en tiempo real ('camara:actualizada' /
 * 'camara:eliminada'). La verificación de conectividad y la sincronización con MediaMTX y el
 * motor ANPR corren en segundo plano: la respuesta no las espera y un fallo no la afecta (se
 * corrige en la siguiente sincronización periódica).
 */

// ─── Puertos ─────────────────────────────────────────────────────────────────

/** Datos de conexión de una cámara (sin el conteo de detecciones). */
export interface ConexionCamara {
  id: number;
  nombre: string;
  ip: string;
  rtsp_url: string;
  activa: boolean;
}

export interface RepositorioCamaras {
  /** Todas las cámaras, por nombre, con el número de detecciones */
  listar(): Promise<CamaraGuardada[]>;
  obtener(id: number): Promise<CamaraGuardada | null>;
  conexion(id: number): Promise<ConexionCamara | null>;
  /** Cámaras habilitadas (diagnóstico de todas) */
  habilitadas(): Promise<Omit<ConexionCamara, 'activa'>[]>;
  crear(c: DatosCamara, usuarioId: number): Promise<number>;
  /** Si cambia la URL, la conectividad vuelve a SIN_VERIFICAR */
  actualizar(id: number, c: DatosCamara): Promise<void>;
  /** Invierte la habilitación; null si la cámara no existe */
  alternarActiva(id: number): Promise<{ nombre: string; activa: boolean } | null>;
  /** Guarda la región de interés; devuelve el nombre de la cámara o null si no existe */
  fijarRoi(id: number, roi: Punto[] | null): Promise<string | null>;
  eliminar(id: number): Promise<void>;
}

export type DiagnosticoRtsp = 'ok' | 'requiere_credenciales' | 'credenciales_invalidas' | 'ruta_no_encontrada' | 'rechazado' | 'sin_respuesta' | 'url_invalida';

/** Resultado del DESCRIBE RTSP a la cámara. */
export interface ResultadoRtsp {
  host: string | null;
  puerto: number | null;
  en_linea: boolean;
  diagnostico: DiagnosticoRtsp;
  tiempo_ms: number | null;
  mensaje: string;
  servidor?: string | null;
}

/** Resultado del ping ICMP al equipo. */
export interface ResultadoPing {
  host: string;
  responde: boolean;
  tiempo_ms: number | null;
  mensaje: string;
}

export interface DiagnosticoCamara {
  /** null si no se pudo determinar el host */
  ping: ResultadoPing | null;
  rtsp: ResultadoRtsp;
}

/** Conectividad con las cámaras: red (ping) y servicio de video (RTSP). */
export interface PuertoConectividad {
  /** Host al que apunta la URL (o la IP indicada); null si la URL no es válida */
  destino(rtsp: string, ip: string | null): { host: string } | null;
  probar(rtsp: string, ip: string | null): Promise<ResultadoRtsp>;
  diagnosticar(rtsp: string, ip: string | null): Promise<DiagnosticoCamara>;
  /** Guarda el resultado en la cámara y avisa en tiempo real (y al personal si se desconectó) */
  registrar(camaraId: number, resultado: ResultadoRtsp, forzarAviso: boolean): Promise<void>;
}

export interface EstadoRutaVideo {
  lista: boolean;
  lectores: number;
  pistas: string[];
}

/** Servidor de medios (MediaMTX): una ruta cam_<id> por cámara habilitada y rutas de prueba. */
export interface PuertoServidorVideo {
  rutaCamara(id: number): string;
  /** URL con la que el motor ANPR lee una ruta (autenticado con el token de servicio) */
  urlLecturaMotor(ruta: string): string;
  /** URL WebRTC vista desde el navegador */
  urlWebrtc(): string;
  sincronizarRutas(): Promise<void>;
  crearRutaPrueba(rtsp: string): Promise<string>;
  eliminarRutaPrueba(ruta: string): Promise<void>;
  /** null si el servidor no responde */
  estadoRuta(ruta: string): Promise<EstadoRutaVideo | null>;
  /** Cámara registrada y habilitada a la que corresponde una ruta cam_<id> */
  camaraDeRuta(ruta: string): Promise<number | null>;
}

/** Credenciales de lectura del video: tickets de 60 s para el navegador y el token del motor. */
export interface PuertoTickets {
  emitir(usuarioId: number, alcance: AlcanceTicket): string;
  valido(ticket: string | null | undefined, alcance: AlcanceTicket): boolean;
  esMotor(usuario: string, clave: string): boolean;
}

export interface EstadoMotor {
  en_linea: boolean;
  fps_captura?: number;
  fps_procesamiento?: number;
  detector?: string | null;
  ocr?: string | null;
  verificador?: string | null;
  camara_activa?: { id: number; conectada: boolean } | null;
  error?: string;
}

/** Motor ANPR (microservicio de reconocimiento) y la cámara que procesa. */
export interface PuertoMotorAnpr {
  /** Nunca falla: si no responde, en_linea = false */
  estado(): Promise<EstadoMotor>;
  /** Cámara que debería procesar: la elegida si está habilitada, o la primera habilitada */
  camaraDeseada(): Promise<{ id: number } | null>;
  /** true si el motor procesa exactamente la ruta de esa cámara */
  procesa(camara: { id: number } | null): Promise<boolean>;
  /** Recuerda la cámara elegida (se reaplica si el motor se reinicia) */
  guardarCamara(camaraId: number, usuarioId: number | null): Promise<void>;
  cambiarCamara(camara: { id: number; nombre: string; rtsp_url: string }, forzar: boolean): Promise<unknown>;
  /** Aplica la región de interés si esa cámara es la que procesa */
  fijarRoi(camaraId: number, roi: Punto[] | null): Promise<unknown>;
  /** Reaplica la cámara deseada si el motor está en otra fuente */
  sincronizar(): Promise<unknown>;
  /** URL del servicio vista desde el navegador (WebSocket de video) */
  urlPublica(): string;
}

export interface DependenciasCamaras {
  repositorio: RepositorioCamaras;
  conectividad: PuertoConectividad;
  video: PuertoServidorVideo;
  tickets: PuertoTickets;
  motor: PuertoMotorAnpr;
  auditoria: PuertoAuditoria;
  eventos: PuertoEventos;
}

// ─── Casos de uso ────────────────────────────────────────────────────────────

/** Tarea en segundo plano: la respuesta no la espera y un fallo no afecta la operación. */
function enSegundoPlano(tarea: () => Promise<unknown>): void {
  void (async () => {
    try {
      await tarea();
    } catch { /* se corrige en la siguiente sincronización periódica */ }
  })();
}

const cuerpo = (entrada: unknown): Record<string, unknown> =>
  (entrada && typeof entrada === 'object' ? entrada as Record<string, unknown> : {});

export function casosCamaras(d: DependenciasCamaras) {
  const difundir = (camara: CamaraPublica) => d.eventos.emitir('camara:actualizada', camara);

  /** Verificación de conectividad tras el alta o el cambio de URL (avisa aunque no cambie el estado). */
  const verificar = (id: number, c: DatosCamara) =>
    enSegundoPlano(async () => d.conectividad.registrar(id, await d.conectividad.probar(c.rtsp, c.ip), true));

  /** MediaMTX publica las cámaras habilitadas y el motor retoma la cámara que le corresponde. */
  const sincronizar = () => enSegundoPlano(async () => {
    await d.video.sincronizarRutas();
    await d.motor.sincronizar();
  });

  async function obtener(id: number): Promise<CamaraPublica> {
    const c = await d.repositorio.obtener(id);
    if (!c) throw errorNoEncontrado('Cámara no encontrada.');
    return presentarCamara(c);
  }

  /** Valida el formulario; el host del ping es la IP indicada o, si no hay, el de la URL. */
  function validar(entrada: unknown, rtspGuardada?: string): DatosCamara {
    const r = leerCamara(cuerpo(entrada), rtspGuardada);
    if (!r.ok) throw errorValidacion(r.error);
    const destino = d.conectividad.destino(r.valor.rtsp, r.valor.ip);
    if (!destino) throw errorValidacion('No se pudo determinar el host de la cámara. Revise la URL o la IP.');
    // El host de la URL se guarda como IP del ping: no se recorta (apuntaría a otro equipo)
    if (!r.valor.ip && destino.host.length > LARGO_MAXIMO_IP) {
      throw errorValidacion(`El host de la URL supera los ${LARGO_MAXIMO_IP} caracteres: indique la IP de la cámara.`);
    }
    return { nombre: r.valor.nombre, ubicacion: r.valor.ubicacion, rtsp: r.valor.rtsp, ip: r.valor.ip || destino.host };
  }

  /**
   * URL de una prueba (Ping o Play del formulario, sin guardar). Con `camara_id`, una URL
   * enmascarada recupera la contraseña guardada de esa cámara.
   */
  async function urlDePrueba(b: Record<string, unknown>): Promise<Validado<string>> {
    const camaraId = leerIdCamara(b.camara_id);
    if (!camaraId.ok) throw errorValidacion(camaraId.error);
    const texto = typeof b.rtsp_url === 'string' ? b.rtsp_url : '';
    const guardada = camaraId.valor && texto.includes(MASCARA) ? (await d.repositorio.conexion(camaraId.valor))?.rtsp_url : null;
    return leerUrlRtsp(b.rtsp_url, guardada);
  }

  /** Cámara registrada o 404. */
  async function conexion(id: number): Promise<ConexionCamara> {
    const c = await d.repositorio.conexion(id);
    if (!c) throw errorNoEncontrado('Cámara no encontrada.');
    return c;
  }

  return {
    listar: async () => (await d.repositorio.listar()).map(presentarCamara),

    obtener,

    async registrar(entrada: unknown, actor: Actor) {
      const c = validar(entrada);
      const id = await d.repositorio.crear(c, actor.id);
      await d.auditoria.operacion(actor, 'CAMARA_ALTA', 'camara', id, `${c.nombre} · ${c.ubicacion}`);
      verificar(id, c);
      sincronizar();
      const camara = await obtener(id);
      difundir(camara);
      return camara;
    },

    async editar(id: number, entrada: unknown, actor: Actor) {
      const actual = await d.repositorio.obtener(id);
      if (!actual) throw errorNoEncontrado('Cámara no encontrada.');
      const c = validar(entrada, actual.rtsp_url);
      await d.repositorio.actualizar(id, c);
      const cambios = cambiosCamara(actual, c);
      await d.auditoria.operacion(actor, 'CAMARA_EDICION', 'camara', id, `${c.nombre}: ${cambios.join(', ') || 'sin cambios'}`);
      if (actual.rtsp_url !== c.rtsp) {
        verificar(id, c);
        // MediaMTX reabre la cámara con la URL nueva; el motor sigue leyendo la misma ruta cam_<id>
        enSegundoPlano(() => d.video.sincronizarRutas());
      }
      const camara = await obtener(id);
      difundir(camara);
      return camara;
    },

    /** Habilita o deshabilita; `activa` es el estado resultante. */
    async alternar(id: number, actor: Actor) {
      const r = await d.repositorio.alternarActiva(id);
      if (!r) throw errorNoEncontrado('Cámara no encontrada.');
      await d.auditoria.operacion(actor, r.activa ? 'CAMARA_HABILITADA' : 'CAMARA_DESHABILITADA', 'camara', id, r.nombre);
      sincronizar();
      const camara = await obtener(id);
      difundir(camara);
      return { camara, activa: r.activa };
    },

    /**
     * Región de interés: el motor solo busca placas cuyo centro cae dentro del polígono
     * (máscara de detección de OpenALPR). Sin región (null) se analiza el cuadro completo.
     */
    async fijarRoi(id: number, entrada: unknown, actor: Actor) {
      const roi = leerRoi(entrada ?? null);
      if (!roi.ok) throw errorValidacion(roi.error);
      const nombre = await d.repositorio.fijarRoi(id, roi.valor);
      if (nombre === null) throw errorNoEncontrado('Cámara no encontrada.');
      await d.auditoria.operacion(actor, 'CAMARA_ROI', 'camara', id,
        `${nombre}: ${roi.valor ? `región de ${roi.valor.length} vértices` : 'cuadro completo'}`);
      // Si el motor procesa esta cámara la aplica al instante; si no, al activarla
      enSegundoPlano(() => d.motor.fijarRoi(id, roi.valor));
      const camara = await obtener(id);
      difundir(camara);
      return { camara, roi: roi.valor };
    },

    /** Solo se elimina una cámara sin detecciones; con historial se deshabilita. */
    async eliminar(id: number, actor: Actor) {
      const c = await d.repositorio.obtener(id);
      if (!c) throw errorNoEncontrado('Cámara no encontrada.');
      if (Number(c.detecciones ?? 0) > 0) {
        throw errorConflicto(`La cámara tiene ${c.detecciones} detecciones registradas: deshabilítela en lugar de eliminarla para conservar el historial.`);
      }
      await d.repositorio.eliminar(id);
      await d.auditoria.operacion(actor, 'CAMARA_ELIMINADA', 'camara', id, c.nombre);
      d.eventos.emitir('camara:eliminada', { id });
      sincronizar();
    },

    /** Ping + diagnóstico RTSP de una URL que aún no se guarda (formulario). */
    async probar(entrada: unknown) {
      const b = cuerpo(entrada);
      const ip = leerIp(b.ip);
      if (!ip.ok) throw errorValidacion(ip.error);
      const rtsp = await urlDePrueba(b);
      if (!rtsp.ok) throw errorValidacion(rtsp.error);
      return d.conectividad.diagnosticar(rtsp.valor, ip.valor);
    },

    /** Ping ICMP (red) + diagnóstico RTSP de una cámara registrada; el resultado se guarda. */
    async diagnosticar(id: number) {
      const c = await conexion(id);
      const r = await d.conectividad.diagnosticar(c.rtsp_url, c.ip);
      await d.conectividad.registrar(id, r.rtsp, true);
      return r;
    },

    async diagnosticarTodas() {
      const camaras = await d.repositorio.habilitadas();
      const detalles = await Promise.all(camaras.map(async c => {
        const r = await d.conectividad.diagnosticar(c.rtsp_url, c.ip);
        await d.conectividad.registrar(c.id, r.rtsp, true);
        return { id: c.id, nombre: c.nombre, ...r };
      }));
      return { total: detalles.length, en_linea: detalles.filter(x => x.rtsp.en_linea).length, detalles };
    },

    /** Reproducción (“Play”) de una cámara registrada: su ruta cam_<id> y un ticket WebRTC. */
    async video(id: number, actor: Actor) {
      const c = await conexion(id);
      if (!c.activa) throw errorConflicto('Habilite la cámara para reproducir su video.');
      await d.video.sincronizarRutas();
      return { ruta: d.video.rutaCamara(id), ticket: d.tickets.emitir(actor.id, 'stream'), webrtc: d.video.urlWebrtc() };
    },

    /** Ruta temporal para reproducir una URL sin guardarla (se elimina al cerrar o a los 3 minutos). */
    async pruebaVideo(entrada: unknown, actor: Actor) {
      const rtsp = await urlDePrueba(cuerpo(entrada));
      if (!rtsp.ok || !d.conectividad.destino(rtsp.valor, null)) throw errorValidacion('URL RTSP inválida.');
      const ruta = await d.video.crearRutaPrueba(rtsp.valor);
      return { ruta, ticket: d.tickets.emitir(actor.id, 'stream'), webrtc: d.video.urlWebrtc() };
    },

    /** Solo se eliminan rutas temporales prueba_<hex>; cualquier otro nombre se ignora (nunca una cam_<id>). */
    async eliminarPruebaVideo(ruta: string) {
      if (RE_RUTA_PRUEBA.test(ruta)) await d.video.eliminarRutaPrueba(ruta);
    },

    /** Estado del flujo en el servidor de video (fuente lista, lectores, pistas). */
    async estadoVideo(ruta: string): Promise<EstadoRutaVideo> {
      if (!RE_RUTA_VIDEO.test(ruta)) throw errorValidacion('Ruta inválida.');
      return (await d.video.estadoRuta(ruta)) ?? { lista: false, lectores: 0, pistas: [] };
    },
  };
}

export type CasosCamaras = ReturnType<typeof casosCamaras>;
