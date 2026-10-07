import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Maximize2, PauseCircle, Radio, VideoOff } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { usePaginaVisible } from '../../aplicacion/hooks';
import { conectarWhep, crearMedidor, EstadisticasVideo, SesionWhep } from '../../infraestructura/webrtc';
import { areaVideo, crearHud, Hud, MovimientoHud, PistaHud, Punto } from './hud';
import { Aviso, Modal } from './ui';

/**
 * Video en vivo por WebRTC (MediaMTX) con el HUD de detección del motor ANPR dibujado encima.
 * El video no pasa por el motor: MediaMTX reenvía el H.264 de la cámara sin re-codificar, y el
 * motor solo envía por WebSocket las pistas y la zona de movimiento (JSON).
 *
 * Cada placa en seguimiento se dibuja desde que aparece y sigue al vehículo: "ESCANEANDO OCR"
 * mientras se lee, la placa al leerla y el color del estado decidido por el backend (ver
 * hud.ts). La región de interés de la cámara se muestra con el exterior atenuado.
 */

interface AreaVideo { x: number; y: number; w: number; h: number }

type Estado = 'conectando' | 'en_vivo' | 'pausado' | 'oculto' | 'reconectando' | 'error' | 'sin_camara';

/** Pistas del WebSocket /ws/pistas del motor → HUD. */
function pistasDelMotor(lista: any[]): PistaHud[] {
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

const Insignias: React.FC<{ stats: EstadisticasVideo | null; etiqueta: string }> = ({ stats, etiqueta }) => (
  <>
    <span className="insignia" style={{ position: 'absolute', left: 10, top: 10, background: 'rgba(185,28,28,0.92)', borderColor: 'transparent', color: '#fff' }}>
      <Radio size={12} /> {etiqueta}
    </span>
    {stats && (
      <span className="insignia" style={{ position: 'absolute', right: 52, top: 10, background: 'rgba(2,6,23,0.72)', borderColor: 'transparent', color: '#e2e8f0' }}
        title="Retardo estimado (red + búfer del navegador), cuadros por segundo, resolución y ancho de banda">
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
    const hud: Hud = crearHud(lienzo.current!, () => (v.videoWidth ? areaVideo(v) : null));

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
        const a = areaVideo(v);
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
              hud.actualizar(pistasDelMotor(m.pistas), (m.movimiento as MovimientoHud | null) ?? null, (m.roi as Punto[] | null) ?? null);
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
      ws?.close();
      hud.detener();
      sesion?.cerrar();
      v.onloadeddata = null;
      onEstadisticas?.(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, intento, claveReinicio]);

  return (
    <div ref={contenedor} style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#050b16', borderRadius: 10, overflow: 'hidden' }}>
      <video ref={video} muted playsInline autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
      <canvas ref={lienzo} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      {capa && area && estado === 'en_vivo' && (
        <div style={{ position: 'absolute', left: area.x, top: area.y, width: area.w, height: area.h }}>{capa}</div>
      )}
      <Superposicion estado={estado} mensaje={mensaje} pausado={pausado} />
      {estado === 'en_vivo' && !capa && <Insignias stats={stats} etiqueta={etiqueta} />}
      <button className="btn btn-sm btn-icono" style={{ position: 'absolute', right: 10, top: 10, background: 'rgba(2,6,23,0.7)', color: '#e2e8f0' }}
        onClick={() => contenedor.current?.requestFullscreen?.().catch(() => undefined)} aria-label="Pantalla completa"><Maximize2 size={14} /></button>
    </div>
  );
};

/** Video de la cámara que procesa el motor, con las detecciones superpuestas. */
export const VisorEnVivo: React.FC<{ camaraId: number | null; pausado: boolean; claveReinicio?: unknown; onFallo: (m: string) => void }> =
  ({ camaraId, pausado, claveReinicio, onFallo }) => {
    if (!camaraId) {
      return (
        <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#050b16', borderRadius: 10 }}>
          <Superposicion estado="sin_camara" pausado={false} />
        </div>
      );
    }
    return (
      <ReproductorWebRTC pausado={pausado} claveReinicio={`${camaraId}-${String(claveReinicio)}`} onFallo={onFallo}
        obtener={async () => {
          const t = (await api.post('/monitoreo/ticket', { alcance: 'stream' })).data;
          const q = `ticket=${encodeURIComponent(t.ticket)}`;
          return { whep: `${t.webrtc}/cam_${camaraId}/whep?${q}`, pistasWs: `${String(t.url).replace(/^http/, 'ws')}/ws/pistas?${q}` };
        }} />
    );
  };

/**
 * “Play” de Administración › Cámaras: reproduce el flujo real por WebRTC y muestra el
 * estado en el servidor de video (fuente activa, lectores conectados, códec) para
 * confirmar que el video se está recibiendo y consumiendo.
 */
export const ReproductorPrueba: React.FC<{ titulo: string; camaraId?: number; rtspUrl?: string; onCerrar: () => void }> = ({ titulo, camaraId, rtspUrl, onCerrar }) => {
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
    const r = camaraId && !rtspUrl
      ? (await api.post(`/camaras/${camaraId}/video`)).data
      : (await api.post('/camaras/prueba-video', { rtsp_url: rtspUrl, camara_id: camaraId })).data;
    if (!camaraId || rtspUrl) {
      if (rutaTemporal.current && rutaTemporal.current !== r.ruta) api.delete(`/camaras/prueba-video/${rutaTemporal.current}`).catch(() => undefined);
      rutaTemporal.current = r.ruta;
    }
    setRuta(r.ruta);
    return { whep: `${r.webrtc}/${r.ruta}/whep?ticket=${encodeURIComponent(r.ticket)}` };
  };

  const h265 = servidor?.pistas.some(p => /265|hevc/i.test(p));
  return (
    <Modal titulo={`Reproducción de prueba · ${titulo}`} subtitulo="Flujo real de la cámara por WebRTC (servidor de video MediaMTX)" onCerrar={onCerrar} tamano="ancho"
      pie={<button className="btn btn-secondary" onClick={onCerrar}>Cerrar</button>}>
      <div className="pila" style={{ gap: 12 }}>
        <ReproductorWebRTC obtener={obtener} etiqueta="PRUEBA · WebRTC" onEstadisticas={setStats}
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
        {h265 && <Aviso tipo="advertencia">La cámara envía <b>H.265</b>: la mayoría de navegadores no lo reproducen por WebRTC. Configure el flujo en <b>H.264</b> en la cámara (el motor ANPR puede procesar ambos).</Aviso>}
        {error && <Aviso tipo="error"><AlertTriangle size={14} style={{ verticalAlign: -2 }} /> {error}</Aviso>}
      </div>
    </Modal>
  );
};
