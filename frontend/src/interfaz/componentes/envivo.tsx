import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Maximize2, PauseCircle, Radio, VideoOff } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { usePaginaVisible } from '../../aplicacion/hooks';
import { conectarWhep, crearMedidor, EstadisticasVideo, SesionWhep } from '../../infraestructura/webrtc';
import { areaVideo, crearHud, Hud, MovimientoHud, PistaHud, Punto } from './hud';
import { Aviso, Modal, Segmentado } from './ui';

/**
 * Video en vivo por WebRTC (MediaMTX) con el HUD de detección del motor ANPR dibujado encima.
 * El video no pasa por el motor: MediaMTX reenvía el H.264 de la cámara sin re-codificar, y el
 * motor solo envía por WebSocket las pistas y la zona de movimiento (JSON).
 *
 * Cada placa en seguimiento se dibuja desde que aparece y sigue al vehículo: "ESCANEANDO OCR"
 * mientras se lee, la placa al leerla y el color del estado decidido por el backend (ver
 * hud.ts). La región de interés de la cámara se muestra con el exterior atenuado.
 *
 * Doble flujo (como los NVR y sistemas ANPR profesionales): el motor analiza el flujo principal
 * de la cámara a máxima resolución y el navegador puede mostrar el secundario (cam_<id>_vista,
 * H.264 de baja resolución), que consume una fracción del ancho de banda y se reproduce en
 * cualquier navegador aunque el principal sea H.265. Las pistas llegan normalizadas (0–1), así
 * que se dibujan igual sobre cualquiera de los dos.
 */

interface AreaVideo { x: number; y: number; w: number; h: number }

type Estado = 'conectando' | 'en_vivo' | 'pausado' | 'oculto' | 'reconectando' | 'error' | 'sin_camara';

/** Pista tal como la envía /ws/pistas del motor (coordenadas normalizadas 0–1). */
interface PistaMotor {
  id: number;
  caja: PistaHud['caja'];
  puntos?: Punto[] | null;
  velocidad?: [number, number];
  confianza?: number;
  placa?: string | null;
  parcial?: string | null;
  confianza_placa?: number;
  estado?: string | null;
}

/** Pistas del WebSocket /ws/pistas del motor → HUD. */
function pistasDelMotor(lista: PistaMotor[] | undefined): PistaHud[] {
  return (lista ?? []).map(p => ({
    id: p.id,
    caja: p.caja,
    puntos: p.puntos ?? null,
    velocidad: p.velocidad ?? [0, 0],
    confianza: p.confianza ?? 0,
    placa: p.placa ?? null,
    parcial: p.parcial ?? null,
    confianzaPlaca: p.confianza_placa ?? 0,
    estado: p.estado ?? null,
  }));
}

const Superposicion: React.FC<{ estado: Estado; mensaje?: string | null; pausado: boolean }> = ({ estado, mensaje }) => {
  const contenido = {
    conectando: [<Loader2 key="i" size={26} className="girar" />, 'Conectando con la cámara…'],
    reconectando: [<Loader2 key="i" size={26} className="girar" />, mensaje || 'Reconectando…'],
    pausado: [<PauseCircle key="i" size={26} />, 'Video en pausa. Las detecciones siguen llegando en tiempo real.'],
    oculto: [<PauseCircle key="i" size={26} />, 'Video detenido mientras la pestaña no está visible.'],
    error: [<VideoOff key="i" size={26} />, mensaje || 'Video no disponible.'],
    sin_camara: [<VideoOff key="i" size={26} />, 'No hay una cámara asignada al motor ANPR.'],
    en_vivo: null,
  }[estado];
  if (!contenido) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
      color: '#cbd5e1', background: 'rgba(5,11,22,0.6)', textAlign: 'center', padding: 20, fontSize: 13 }}>
      {contenido[0]}<span style={{ maxWidth: 380 }}>{contenido[1]}</span>
    </div>
  );
};

const Insignias: React.FC<{ stats: EstadisticasVideo | null; etiqueta: string; ajustada: boolean }> = ({ stats, etiqueta, ajustada }) => (
  <>
    <span className="insignia" style={{ position: 'absolute', left: 10, top: 10, background: 'rgba(185,28,28,0.92)', borderColor: 'transparent', color: '#fff' }}>
      <Radio size={12} /> {etiqueta}
    </span>
    {stats && (
      <span className="insignia" style={{ position: 'absolute', right: 52, top: 10, background: 'rgba(2,6,23,0.72)', borderColor: 'transparent', color: '#e2e8f0' }}
        title={`Retardo estimado (red + búfer del navegador), cuadros por segundo, resolución y ancho de banda${ajustada
          ? '. La imagen se muestra con la proporción del flujo que analiza el motor.' : ''}`}>
        {stats.latencia_ms !== null && <>≈ {stats.latencia_ms} ms · </>}{stats.fps} fps · {stats.ancho}×{stats.alto} · {stats.kbps} kbps
      </span>
    )}
  </>
);

/**
 * Reproductor WebRTC genérico. `obtener` entrega la URL WHEP (con ticket nuevo en cada
 * intento). Llama a `onFallo` tras varios intentos fallidos consecutivos.
 */
export const ReproductorWebRTC: React.FC<{
  obtener: () => Promise<{ whep: string; pistasWs?: string | null }>;
  pausado?: boolean;
  claveReinicio?: unknown;
  etiqueta?: string;
  onFallo?: (mensaje: string) => void;
  onEstadisticas?: (s: EstadisticasVideo | null) => void;
  /** Capa interactiva colocada exactamente sobre la imagen del video (p. ej. el editor de región) */
  capa?: React.ReactNode;
}> = ({ obtener, pausado = false, claveReinicio, etiqueta = 'EN VIVO · WebRTC', onFallo, onEstadisticas, capa }) => {
  const visible = usePaginaVisible();
  const video = useRef<HTMLVideoElement>(null);
  const lienzo = useRef<HTMLCanvasElement>(null);
  const contenedor = useRef<HTMLDivElement>(null);
  const [estado, setEstado] = useState<Estado>('conectando');
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [stats, setStats] = useState<EstadisticasVideo | null>(null);
  const [intento, setIntento] = useState(0);
  const [area, setArea] = useState<AreaVideo | null>(null);
  // Proporción del flujo que analiza el motor cuando la vista llega con otra (p. ej. un secundario
  // de 640×480 de un sensor 16:9): la cámara escala sin recortar, así que se muestra estirada a la
  // proporción real y la imagen y los recuadros conservan la geometría.
  const [ajuste, setAjuste] = useState<number | null>(null);
  const ajusteActual = useRef<number | null>(null);
  const fallos = useRef(0);
  const activo = visible && !pausado;

  useEffect(() => { fallos.current = 0; setIntento(0); }, [claveReinicio]);

  useEffect(() => {
    if (!activo) { setEstado(pausado ? 'pausado' : 'oculto'); setStats(null); return; }
    let cerrado = false;
    let sesion: SesionWhep | null = null;
    let ws: WebSocket | null = null;
    let timerStats: number | undefined;
    let vigilancia: number | undefined;
    let reintento: number | undefined;
    const v = video.current!;
    const hud: Hud = crearHud(lienzo.current!, () => (v.videoWidth ? areaVideo(v, ajusteActual.current) : null));
    let aspectoMotor: number | null = null;
    const revisarAspecto = () => {
      const propio = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : null;
      const nuevo = aspectoMotor && propio && Math.abs(propio / aspectoMotor - 1) > 0.03 ? aspectoMotor : null;
      if (nuevo !== ajusteActual.current) { ajusteActual.current = nuevo; setAjuste(nuevo); }
    };
    v.addEventListener('resize', revisarAspecto);

    const fallar = (texto: string) => {
      if (cerrado) return;
      fallos.current += 1;
      setMensaje(texto);
      if (fallos.current >= 3 && onFallo) { setEstado('error'); onFallo(texto); return; }
      setEstado('reconectando');
      reintento = window.setTimeout(() => setIntento(i => i + 1), Math.min(10000, 1500 * fallos.current));
    };
    // El HUD se redimensiona solo; aquí se mantiene el área de la capa interactiva
    const redibujar = () => {
      if (v.videoWidth) {
        const a = areaVideo(v, ajusteActual.current);
        setArea(prev => (prev && prev.x === a.x && prev.y === a.y && prev.w === a.w && prev.h === a.h ? prev : { x: a.x, y: a.y, w: a.w, h: a.h }));
      }
    };
    const ro = new ResizeObserver(redibujar);
    ro.observe(v);

    setEstado(intento ? 'reconectando' : 'conectando');
    (async () => {
      try {
        const { whep, pistasWs } = await obtener();
        if (cerrado) return;
        sesion = await conectarWhep(v, whep);
        if (cerrado) { sesion.cerrar(); return; }
        const medir = crearMedidor(sesion.pc);
        sesion.pc.addEventListener('connectionstatechange', () => {
          const s = sesion?.pc.connectionState;
          if (s === 'failed' || s === 'disconnected') fallar('Se perdió la conexión de video.');
        });
        // Si no llega ningún cuadro en 10 s, la cámara no está enviando video
        vigilancia = window.setTimeout(() => { if (!v.videoWidth) fallar('La cámara no está enviando video (sin señal).'); }, 10000);
        v.onloadeddata = () => { fallos.current = 0; setEstado('en_vivo'); setMensaje(null); window.clearTimeout(vigilancia); redibujar(); };
        timerStats = window.setInterval(async () => {
          const s = await medir().catch(() => null);
          setStats(s);
          onEstadisticas?.(s);
        }, 2000);
        if (pistasWs) {
          ws = new WebSocket(pistasWs);
          ws.onmessage = ev => {
            try {
              const m = JSON.parse(ev.data);
              if (typeof m.aspecto === 'number' && m.aspecto !== aspectoMotor) { aspectoMotor = m.aspecto; revisarAspecto(); }
              hud.actualizar(pistasDelMotor(m.pistas), (m.movimiento as MovimientoHud | null) ?? null, (m.roi as Punto[] | null) ?? null,
                Array.isArray(m.exclusiones) ? (m.exclusiones as Punto[][]) : []);
            } catch { /* mensaje inválido */ }
          };
          ws.onclose = () => hud.limpiar();
        }
      } catch (e) {
        fallar(mensajeError(e, (e as Error)?.message || 'No se pudo abrir el video.'));
      }
    })();

    return () => {
      cerrado = true;
      window.clearTimeout(reintento);
      window.clearTimeout(vigilancia);
      window.clearInterval(timerStats);
      ro.disconnect();
      v.removeEventListener('resize', revisarAspecto);
      ws?.close();
      hud.detener();
      sesion?.cerrar();
      v.onloadeddata = null;
      onEstadisticas?.(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, intento, claveReinicio]);

  return (
    <div ref={contenedor} style={{ position: 'relative', width: '100%', aspectRatio: ajuste ? String(ajuste) : '16 / 9', background: '#050b16', borderRadius: 10, overflow: 'hidden' }}>
      <video ref={video} muted playsInline autoPlay style={{ width: '100%', height: '100%', objectFit: ajuste ? 'fill' : 'contain', display: 'block' }} />
      <canvas ref={lienzo} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      {capa && area && estado === 'en_vivo' && (
        <div style={{ position: 'absolute', left: area.x, top: area.y, width: area.w, height: area.h }}>{capa}</div>
      )}
      <Superposicion estado={estado} mensaje={mensaje} pausado={pausado} />
      {estado === 'en_vivo' && !capa && <Insignias stats={stats} etiqueta={etiqueta} ajustada={ajuste !== null} />}
      <button className="btn btn-sm btn-icono" style={{ position: 'absolute', right: 10, top: 10, background: 'rgba(2,6,23,0.7)', color: '#e2e8f0' }}
        onClick={() => contenedor.current?.requestFullscreen?.().catch(() => undefined)} aria-label="Pantalla completa"><Maximize2 size={14} /></button>
    </div>
  );
};

/**
 * Video de la cámara que procesa el motor, con las detecciones superpuestas. Con `vista`, el
 * flujo secundario de la cámara (el motor sigue analizando el principal).
 */
export const VisorEnVivo: React.FC<{ camaraId: number | null; vista?: boolean; pausado: boolean; claveReinicio?: unknown; onFallo: (m: string) => void }> =
  ({ camaraId, vista = false, pausado, claveReinicio, onFallo }) => {
    if (!camaraId) {
      return (
        <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#050b16', borderRadius: 10 }}>
          <Superposicion estado="sin_camara" pausado={false} />
        </div>
      );
    }
    return (
      <ReproductorWebRTC pausado={pausado} claveReinicio={`${camaraId}-${vista}-${String(claveReinicio)}`} onFallo={onFallo}
        obtener={async () => {
          const t = (await api.post('/monitoreo/ticket', { alcance: 'stream' })).data;
          const q = `ticket=${encodeURIComponent(t.ticket)}`;
          const ruta = `cam_${camaraId}${vista ? '_vista' : ''}`;
          return { whep: `${t.webrtc}/${ruta}/whep?${q}`, pistasWs: `${String(t.url).replace(/^http/, 'ws')}/ws/pistas?${q}` };
        }} />
    );
  };

/**
 * “Play” de Administración › Cámaras: reproduce el flujo real por WebRTC y muestra el
 * estado en el servidor de video (fuente activa, lectores conectados, códec) para
 * confirmar que el video se está recibiendo y consumiendo. Si la cámara tiene flujo
 * secundario se puede reproducir cualquiera de los dos.
 */
type Canal = 'vista' | 'principal';

export const ReproductorPrueba: React.FC<{ titulo: string; camaraId?: number; rtspUrl?: string; rtspUrlVista?: string; onCerrar: () => void }> = ({ titulo, camaraId, rtspUrl, rtspUrlVista, onCerrar }) => {
  const guardada = Boolean(camaraId && !rtspUrl);
  const [canal, setCanal] = useState<Canal>('vista');
  const [hayVista, setHayVista] = useState(Boolean(rtspUrlVista));
  const enVista = canal === 'vista' && hayVista;
  const [ruta, setRuta] = useState<string | null>(null);
  const [servidor, setServidor] = useState<{ lista: boolean; lectores: number; pistas: string[] } | null>(null);
  const [stats, setStats] = useState<EstadisticasVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rutaTemporal = useRef<string | null>(null);

  // Estado del flujo en MediaMTX cada 2 s mientras la vista previa está abierta
  useEffect(() => {
    if (!ruta) return;
    const leer = () => api.get(`/camaras/video/${ruta}/estado`).then(r => setServidor(r.data)).catch(() => undefined);
    leer();
    const id = window.setInterval(leer, 2000);
    return () => window.clearInterval(id);
  }, [ruta]);

  useEffect(() => () => {
    if (rutaTemporal.current) api.delete(`/camaras/prueba-video/${rutaTemporal.current}`).catch(() => undefined);
  }, []);

  const obtener = async () => {
    const vista = canal === 'vista' && (guardada || Boolean(rtspUrlVista));
    const r = guardada
      ? (await api.post(`/camaras/${camaraId}/video`)).data
      : (await api.post('/camaras/prueba-video', { rtsp_url: vista ? rtspUrlVista : rtspUrl, camara_id: camaraId, vista })).data;
    if (!guardada) {
      if (rutaTemporal.current && rutaTemporal.current !== r.ruta) api.delete(`/camaras/prueba-video/${rutaTemporal.current}`).catch(() => undefined);
      rutaTemporal.current = r.ruta;
    } else {
      setHayVista(Boolean(r.ruta_vista));
    }
    const elegida: string = guardada && vista && r.ruta_vista ? r.ruta_vista : r.ruta;
    setRuta(elegida);
    return { whep: `${r.webrtc}/${elegida}/whep?ticket=${encodeURIComponent(r.ticket)}` };
  };

  const cambiarCanal = (c: Canal) => { setCanal(c); setServidor(null); setStats(null); setError(null); };
  const h265 = servidor?.pistas.some(p => /265|hevc/i.test(p));
  return (
    <Modal titulo={`Reproducción de prueba · ${titulo}`} subtitulo="Flujo real de la cámara por WebRTC (servidor de video MediaMTX)" onCerrar={onCerrar} tamano="ancho"
      pie={<button className="btn btn-secondary" onClick={onCerrar}>Cerrar</button>}>
      <div className="pila" style={{ gap: 12 }}>
        {hayVista && (
          <div className="fila" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Segmentado valor={canal} onCambiar={cambiarCanal} opciones={[
              { valor: 'vista', etiqueta: 'Flujo secundario · vista en vivo' },
              { valor: 'principal', etiqueta: 'Flujo principal · motor ANPR' },
            ]} />
            <span className="texto-secundario">El motor analiza el principal; el navegador muestra el secundario.</span>
          </div>
        )}
        <ReproductorWebRTC obtener={obtener} etiqueta="PRUEBA · WebRTC" onEstadisticas={setStats} claveReinicio={canal}
          onFallo={m => setError(m)} />
        <div className="grid-3" style={{ gap: 10 }}>
          <div className="tarjeta" style={{ padding: 12 }}>
            <span className="etiqueta-campo">Fuente en el servidor</span>
            <p className="fila" style={{ gap: 6, marginTop: 4, fontWeight: 600 }}>
              <span className={`punto ${servidor?.lista ? 'verde' : 'ambar latido'}`} />
              {servidor?.lista ? 'Recibiendo de la cámara' : 'Abriendo la cámara…'}</p>
            <span className="texto-secundario">{servidor ? `${servidor.lectores} ${servidor.lectores === 1 ? 'lector' : 'lectores'} conectados` : '—'}</span>
          </div>
          <div className="tarjeta" style={{ padding: 12 }}>
            <span className="etiqueta-campo">Video recibido</span>
            <p style={{ marginTop: 4, fontWeight: 600 }}>{stats ? `${stats.ancho}×${stats.alto} · ${stats.fps} fps` : '—'}</p>
            <span className="texto-secundario">{stats ? `${stats.kbps} kbps · ${stats.codec ?? servidor?.pistas.join(', ') ?? ''}` : 'Esperando cuadros'}</span>
          </div>
          <div className="tarjeta" style={{ padding: 12 }}>
            <span className="etiqueta-campo">Retardo estimado</span>
            <p style={{ marginTop: 4, fontWeight: 600 }}>{stats?.latencia_ms !== null && stats?.latencia_ms !== undefined ? `≈ ${stats.latencia_ms} ms` : '—'}</p>
            <span className="texto-secundario">Red local + búfer del navegador{stats?.perdidos ? ` · ${stats.perdidos} paquetes perdidos` : ''}</span>
          </div>
        </div>
        {h265 && (enVista
          ? <Aviso tipo="advertencia">El flujo secundario también llega en <b>H.265</b>. Configúrelo en <b>H.264</b> en la cámara
            (Configuración › Video › Sub Stream, 640×360) para que se reproduzca en cualquier navegador.</Aviso>
          : <Aviso tipo="advertencia">Este flujo llega en <b>H.265</b>: el motor ANPR lo procesa sin problema, pero por WebRTC solo
            lo reproducen Safari y Chrome con decodificación por hardware. {hayVista
              ? 'La vista en vivo usa el flujo secundario.'
              : 'Active en la cámara la “vista en vivo por el flujo secundario” (H.264) o configure el principal en H.264.'}</Aviso>)}
        {error && <Aviso tipo="error"><AlertTriangle size={14} style={{ verticalAlign: -2 }} /> {error}</Aviso>}
      </div>
    </Modal>
  );
};
