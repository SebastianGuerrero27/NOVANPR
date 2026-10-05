/**
 * Cliente WHEP (WebRTC-HTTP Egress Protocol) para reproducir rutas de MediaMTX.
 *
 * WebRTC entrega el H.264 de la cámara tal cual (sin transcodificar) sobre UDP/RTP y el
 * navegador lo decodifica por hardware: la latencia típica en red local es de 0,1–0,4 s,
 * frente a 2–6 s de HLS o al costo de re-comprimir cada cuadro en JPEG.
 */

export class ErrorWhep extends Error {
  constructor(message: string, public estado?: number) { super(message); }
}

export interface SesionWhep {
  pc: RTCPeerConnection;
  cerrar: () => void;
}

function esperarIce(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const t = window.setTimeout(listo, ms);
    function listo() { window.clearTimeout(t); pc.removeEventListener('icegatheringstatechange', cambio); resolve(); }
    function cambio() { if (pc.iceGatheringState === 'complete') listo(); }
    pc.addEventListener('icegatheringstatechange', cambio);
  });
}

/** Conecta un <video> a una URL WHEP. Rechaza si el servidor no acepta la sesión. */
export async function conectarWhep(video: HTMLVideoElement, url: string): Promise<SesionWhep> {
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = e => {
    // Búfer de reproducción mínimo: prioriza latencia sobre suavidad
    const receptor = e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
    try { if ('jitterBufferTarget' in receptor) receptor.jitterBufferTarget = 0; } catch { /* no soportado */ }
    try { if ('playoutDelayHint' in receptor) receptor.playoutDelayHint = 0; } catch { /* no soportado */ }
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    video.play().catch(() => undefined);
  };

  let ubicacion: string | null = null;
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await esperarIce(pc, 1500);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp });
    if (r.status !== 201) {
      throw new ErrorWhep(
        r.status === 401 ? 'Acceso al video no autorizado (ticket vencido).'
          : r.status === 404 ? 'La cámara no está disponible en el servidor de video.'
            : r.status === 400 ? 'El servidor de video no pudo abrir el flujo (¿cámara sin señal o códec no compatible?).'
              : `El servidor de video respondió ${r.status}.`, r.status);
    }
    ubicacion = r.headers.get('Location');
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
  } catch (e) {
    pc.close();
    if (e instanceof ErrorWhep) throw e;
    throw new ErrorWhep('No se pudo contactar con el servidor de video.');
  }

  return {
    pc,
    cerrar: () => {
      pc.close();
      video.srcObject = null;
      // Libera la sesión en el servidor sin esperar al vencimiento por inactividad
      if (ubicacion) fetch(new URL(ubicacion, url).toString(), { method: 'DELETE' }).catch(() => undefined);
    },
  };
}

export interface EstadisticasVideo {
  fps: number;
  kbps: number;
  ancho: number;
  alto: number;
  /** Retardo estimado de red + búfer del navegador (ms) */
  latencia_ms: number | null;
  perdidos: number;
  codec: string | null;
}

/** Estadísticas de la recepción de video, calculadas entre dos muestras de getStats(). */
export function crearMedidor(pc: RTCPeerConnection) {
  let anterior: { t: number; bytes: number; jbDelay: number; jbCount: number } | null = null;
  return async (): Promise<EstadisticasVideo | null> => {
    const informe = await pc.getStats();
    let entrada: any = null;
    let par: any = null;
    const codecs = new Map<string, string>();
    informe.forEach((s: any) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') entrada = s;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') par = s;
      if (s.type === 'codec') codecs.set(s.id, String(s.mimeType ?? '').replace('video/', ''));
    });
    if (!entrada) return null;
    const ahora = entrada.timestamp as number;
    let kbps = 0;
    let buffer: number | null = null;
    if (anterior) {
      const dt = (ahora - anterior.t) / 1000;
      kbps = dt > 0 ? Math.round(((entrada.bytesReceived - anterior.bytes) * 8) / dt / 1000) : 0;
      const dCount = (entrada.jitterBufferEmittedCount ?? 0) - anterior.jbCount;
      if (dCount > 0) buffer = (((entrada.jitterBufferDelay ?? 0) - anterior.jbDelay) / dCount) * 1000;
    }
    anterior = { t: ahora, bytes: entrada.bytesReceived ?? 0, jbDelay: entrada.jitterBufferDelay ?? 0, jbCount: entrada.jitterBufferEmittedCount ?? 0 };
    const rtt = par?.currentRoundTripTime;
    return {
      fps: Math.round(entrada.framesPerSecond ?? 0),
      kbps,
      ancho: entrada.frameWidth ?? 0,
      alto: entrada.frameHeight ?? 0,
      latencia_ms: buffer !== null ? Math.round(buffer + (typeof rtt === 'number' ? (rtt * 1000) / 2 : 0)) : null,
      perdidos: entrada.packetsLost ?? 0,
      codec: codecs.get(entrada.codecId) ?? null,
    };
  };
}
