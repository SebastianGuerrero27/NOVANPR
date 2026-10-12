import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Maximize2, PauseCircle, VideoOff, WifiOff } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { usePaginaVisible } from '../../aplicacion/hooks';

/**
 * Video en vivo del motor ANPR por WebSocket (JPEG por cuadro).
 *
 * Consumo mínimo:
 *  - La conexión se cierra cuando la pestaña no está visible o el usuario pausa; al no
 *    haber espectadores el servicio ANPR deja de dibujar y codificar el video.
 *  - Resolución, cuadros por segundo y calidad JPEG los fija el perfil elegido (el servidor
 *    reduce la imagen antes de enviarla).
 *  - Si el navegador todavía está dibujando un cuadro, el siguiente se descarta.
 */
export type PerfilVideo = 'baja' | 'media' | 'alta';

export const PERFILES: Record<PerfilVideo, { etiqueta: string; ancho: number; fps: number; calidad: number }> = {
  baja: { etiqueta: 'Ahorro (480 px · 5 fps)', ancho: 480, fps: 5, calidad: 50 },
  media: { etiqueta: 'Estándar (640 px · 10 fps)', ancho: 640, fps: 10, calidad: 60 },
  alta: { etiqueta: 'Alta (960 px · 15 fps)', ancho: 960, fps: 15, calidad: 72 },
};

type Estado = 'conectando' | 'en_vivo' | 'pausado' | 'oculto' | 'reconectando' | 'error';

export const VisorVideo: React.FC<{ perfil: PerfilVideo; pausado: boolean; claveReinicio?: number }> = ({ perfil, pausado, claveReinicio = 0 }) => {
  const visible = usePaginaVisible();
  const canvas = useRef<HTMLCanvasElement>(null);
  const contenedor = useRef<HTMLDivElement>(null);
  const [estado, setEstado] = useState<Estado>('conectando');
  const [fps, setFps] = useState(0);
  const [kbps, setKbps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);
  const activo = visible && !pausado;

  useEffect(() => {
    if (!activo) {
      setEstado(pausado ? 'pausado' : 'oculto');
      setFps(0);
      return;
    }
    let cerrado = false;
    let ws: WebSocket | null = null;
    let dibujando = false;
    let cuadros = 0;
    let bytes = 0;
    let t0 = performance.now();
    let reintento: number | undefined;
    setEstado(intento ? 'reconectando' : 'conectando');

    (async () => {
      try {
        const { ticket, url } = (await api.post('/monitoreo/ticket', { alcance: 'stream' })).data;
        if (cerrado) return;
        const p = PERFILES[perfil];
        const q = new URLSearchParams({ ticket, ancho: String(p.ancho), fps: String(p.fps), calidad: String(p.calidad) });
        ws = new WebSocket(`${String(url).replace(/^http/, 'ws')}/ws/stream?${q}`);
        ws.binaryType = 'blob';
        ws.onopen = () => { if (!cerrado) { setEstado('en_vivo'); setError(null); } };
        ws.onmessage = async (ev: MessageEvent<Blob>) => {
          if (cerrado || dibujando) return;
          dibujando = true;
          try {
            const bmp = await createImageBitmap(ev.data);
            const c = canvas.current;
            if (c && !cerrado) {
              if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
              c.getContext('2d')?.drawImage(bmp, 0, 0);
            }
            bmp.close();
            cuadros++;
            bytes += ev.data.size;
            const ahora = performance.now();
            if (ahora - t0 >= 2000) {
              setFps(Math.round((cuadros * 1000) / (ahora - t0)));
              setKbps(Math.round((bytes * 8) / (ahora - t0)));
              cuadros = 0; bytes = 0; t0 = ahora;
            }
          } catch { /* cuadro incompleto */ } finally { dibujando = false; }
        };
        ws.onclose = () => {
          if (cerrado) return;
          setEstado('reconectando');
          setFps(0);
          reintento = window.setTimeout(() => setIntento(i => i + 1), Math.min(15000, 2000 * (intento + 1)));
        };
      } catch (e) {
        if (cerrado) return;
        setEstado('error');
        setError(mensajeError(e, 'No se pudo abrir el video.'));
        reintento = window.setTimeout(() => setIntento(i => i + 1), 10000);
      }
    })();

    return () => {
      cerrado = true;
      window.clearTimeout(reintento);
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, perfil, intento, claveReinicio]);

  const pantallaCompleta = () => contenedor.current?.requestFullscreen?.().catch(() => undefined);

  const capa = (() => {
    switch (estado) {
      case 'conectando': return { icono: <Loader2 size={26} className="girar" />, texto: 'Conectando con el video…' };
      case 'reconectando': return { icono: <WifiOff size={26} />, texto: 'Conexión interrumpida. Reintentando…' };
      case 'pausado': return { icono: <PauseCircle size={26} />, texto: 'Video en pausa. Las detecciones siguen llegando en tiempo real.' };
      case 'oculto': return { icono: <PauseCircle size={26} />, texto: 'Video detenido mientras la pestaña no está visible.' };
      case 'error': return { icono: <VideoOff size={26} />, texto: error ?? 'Video no disponible.' };
      default: return null;
    }
  })();

  return (
    <div ref={contenedor} style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', background: '#050b16', borderRadius: 10, overflow: 'hidden' }}>
      <canvas ref={canvas} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} aria-label="Video en vivo del acceso" />
      {capa && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
          color: '#cbd5e1', background: estado === 'pausado' || estado === 'oculto' ? 'rgba(5,11,22,0.72)' : 'rgba(5,11,22,0.5)', textAlign: 'center', padding: 20, fontSize: 13 }}>
          {capa.icono}<span style={{ maxWidth: 360 }}>{capa.texto}</span>
        </div>
      )}
      <div style={{ position: 'absolute', left: 10, top: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
        {estado === 'en_vivo' && (
          <span className="insignia" style={{ background: 'rgba(185,28,28,0.92)', borderColor: 'transparent', color: '#fff' }}>
            <span className="punto" style={{ background: '#fff', width: 6, height: 6 }} /> EN VIVO
          </span>
        )}
      </div>
      <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
        {estado === 'en_vivo' && (
          <span className="insignia" style={{ background: 'rgba(2,6,23,0.7)', borderColor: 'transparent', color: '#e2e8f0' }} title="Cuadros por segundo y ancho de banda recibidos">
            {fps} fps · {kbps} kbps
          </span>
        )}
        <button className="btn btn-sm btn-icono" style={{ background: 'rgba(2,6,23,0.7)', color: '#e2e8f0' }} onClick={pantallaCompleta} aria-label="Pantalla completa"><Maximize2 size={14} /></button>
      </div>
    </div>
  );
};
