/**
 * Comunicación con el microservicio ANPR (FastAPI). El navegador ya no llama a sus
 * endpoints de control: el backend lo hace con el token de servicio y entrega al cliente
 * solo un ticket de corta duración para abrir el WebSocket de video.
 */
import type { EnlaceVideo } from '../../aplicacion/camaras';

const URL_INTERNA = () => (process.env.ANPR_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
/** URL del servicio vista desde el navegador (para el WebSocket de video). */
export const urlPublicaAnpr = () => (process.env.ANPR_PUBLIC_URL || 'http://localhost:8000').replace(/\/$/, '');

const token = () => process.env.ANPR_SERVICE_TOKEN || '';

async function llamar(ruta: string, init: RequestInit = {}, timeoutMs = 3000): Promise<any> {
  const r = await fetch(`${URL_INTERNA()}${ruta}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Servicio-Token': token(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const cuerpo: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(cuerpo?.error || cuerpo?.detail || `HTTP ${r.status}`);
  return cuerpo;
}

/** Percentiles de una latencia del motor (ms), sobre sus últimas mediciones */
export interface PercentilesLatencia { p50_ms: number; p95_ms: number; max_ms: number; muestras: number }

/** Latencia de tiempo real desde la captura de cada cuadro (motor ANPR) */
export interface LatenciaMotor {
  /** Captura → inicio del análisis */
  edad_cuadro: PercentilesLatencia | null;
  /** Captura del cuadro leído → lectura en el HUD */
  lectura_en_vivo: PercentilesLatencia | null;
  /** Captura del mejor cuadro → lectura confirmada por el backend */
  registro: PercentilesLatencia | null;
  /** Cuadros de la cámara descartados porque llegó uno más nuevo (%) */
  cuadros_descartados_pct: number | null;
}

export interface EstadoAnpr {
  en_linea: boolean;
  fps_captura?: number;
  fps_procesamiento?: number;
  latencia?: LatenciaMotor | null;
  detector?: string | null;
  ocr?: string | null;
  verificador?: string | null;
  camara_activa?: { id: number; conectada: boolean } | null;
  enlace?: EnlaceVideo | null;
  error?: string;
}

export async function estadoServicioAnpr(): Promise<EstadoAnpr> {
  try {
    const [s, c] = await Promise.all([llamar('/status', {}, 2500), llamar('/api/camera/active', {}, 2500).catch(() => null)]);
    return {
      en_linea: true,
      fps_captura: s.capture_fps, fps_procesamiento: s.tracker_fps, latencia: s.latencia ?? null,
      detector: s.detector, ocr: s.ocr_engine, verificador: s.ocr_verifier,
      camara_activa: c ? { id: c.camera_id, conectada: Boolean(c.is_connected) } : null,
      enlace: s.enlace_video ?? null,
    };
  } catch (e: any) {
    return { en_linea: false, error: e.name === 'TimeoutError' ? 'Sin respuesta' : 'Servicio no disponible' };
  }
}

export type Punto = [number, number];

export function cambiarCamaraAnpr(camara: { id: number; nombre: string; rtsp_url: string; roi?: Punto[] | null; exclusiones?: Punto[][] },
  forzar = false) {
  return llamar('/api/camera/switch', {
    method: 'POST',
    body: JSON.stringify({
      camera_id: camara.id, source_type: 'rtsp', rtsp_url: camara.rtsp_url, nombre: camara.nombre, force: forzar,
      roi: camara.roi ?? null, exclusiones: camara.exclusiones ?? [],
    }),
  }, 8000);
}

/** Aplica la región de interés y las zonas de exclusión en el motor (solo si esa cámara es la que está procesando). */
export function fijarZonasAnpr(camaraId: number, roi: Punto[] | null, exclusiones: Punto[][]) {
  return llamar('/api/camera/roi', { method: 'POST', body: JSON.stringify({ camara_id: camaraId, roi, exclusiones }) }, 4000);
}

/** Zonas vigentes en el motor (región de interés y exclusiones); undefined si no responde. */
export async function zonasActivasAnpr(): Promise<{ roi: Punto[] | null; exclusiones: Punto[][] } | undefined> {
  try {
    const c = await llamar('/api/camera/active', {}, 2500);
    return { roi: c.roi ?? null, exclusiones: Array.isArray(c.exclusiones) ? c.exclusiones : [] };
  } catch {
    return undefined;
  }
}

/** URL (con credenciales enmascaradas) que el motor está procesando, o null si no responde. */
export async function fuenteActivaAnpr(): Promise<string | null> {
  try {
    return (await llamar('/api/camera/active', {}, 2500)).camera_source ?? null;
  } catch {
    return null;
  }
}
