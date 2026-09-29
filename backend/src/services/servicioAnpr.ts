/**
 * Comunicación con el microservicio ANPR (FastAPI). El navegador ya no llama a sus
 * endpoints de control: el backend lo hace con el token de servicio y entrega al cliente
 * solo un ticket de corta duración para abrir el WebSocket de video.
 */
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

export interface EstadoAnpr {
  en_linea: boolean;
  fps_captura?: number;
  fps_procesamiento?: number;
  detector?: string | null;
  ocr?: string | null;
  verificador?: string | null;
  camara_activa?: { id: number; conectada: boolean } | null;
  error?: string;
}

export async function estadoServicioAnpr(): Promise<EstadoAnpr> {
  try {
    const [s, c] = await Promise.all([llamar('/status', {}, 2500), llamar('/api/camera/active', {}, 2500).catch(() => null)]);
    return {
      en_linea: true,
      fps_captura: s.capture_fps, fps_procesamiento: s.tracker_fps,
      detector: s.detector, ocr: s.ocr_engine, verificador: s.ocr_verifier,
      camara_activa: c ? { id: c.camera_id, conectada: Boolean(c.is_connected) } : null,
    };
  } catch (e: any) {
    return { en_linea: false, error: e.name === 'TimeoutError' ? 'Sin respuesta' : 'Servicio no disponible' };
  }
}

export type Punto = [number, number];

export function cambiarCamaraAnpr(camara: { id: number; nombre: string; rtsp_url: string; roi?: Punto[] | null }, forzar = false) {
  return llamar('/api/camera/switch', {
    method: 'POST',
    body: JSON.stringify({
      camera_id: camara.id, source_type: 'rtsp', rtsp_url: camara.rtsp_url, nombre: camara.nombre, force: forzar,
      roi: camara.roi ?? null,
    }),
  }, 8000);
}

/** Aplica la región de interés en el motor (solo si esa cámara es la que está procesando). */
export function fijarRoiAnpr(camaraId: number, roi: Punto[] | null) {
  return llamar('/api/camera/roi', { method: 'POST', body: JSON.stringify({ camara_id: camaraId, roi }) }, 4000);
}

/** Región de interés vigente en el motor; undefined si no responde. */
export async function roiActivaAnpr(): Promise<Punto[] | null | undefined> {
  try {
    return (await llamar('/api/camera/active', {}, 2500)).roi ?? null;
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
