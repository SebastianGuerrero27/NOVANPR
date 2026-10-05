import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Enlaces firmados a la evidencia fotográfica (vehículo y placa). Las etiquetas <img> no
 * envían el token de sesión, así que la API entrega URLs con vencimiento y firma HMAC:
 * sin firma válida /media responde 403. El vencimiento se redondea a bloques de 6 horas
 * para que la misma imagen conserve la misma URL y el navegador la mantenga en caché.
 */
const BLOQUE_S = 6 * 3600;

const secreto = () => process.env.MEDIA_SECRET || process.env.JWT_SECRET || '';

function firma(archivo: string, exp: number): string {
  return crypto.createHmac('sha256', secreto()).update(`${archivo}:${exp}`).digest('base64url').substring(0, 32);
}

/** Nombre de archivo seguro a partir de una ruta guardada por el servicio ANPR. */
export function archivoDe(ruta: string | null | undefined): string | null {
  if (!ruta) return null;
  const nombre = path.basename(String(ruta).replace(/\\/g, '/'));
  return /^[\w.-]+\.(jpe?g|png|webp)$/i.test(nombre) ? nombre : null;
}

export function urlMedia(ruta: string | null | undefined): string | null {
  const archivo = archivoDe(ruta);
  if (!archivo) return null;
  const exp = (Math.floor(Date.now() / 1000 / BLOQUE_S) + 2) * BLOQUE_S; // vigente 6 a 12 h
  return `/media/${archivo}?exp=${exp}&firma=${firma(archivo, exp)}`;
}

export function firmaValida(archivo: string, exp: unknown, f: unknown): boolean {
  const n = Number(exp);
  if (!Number.isFinite(n) || n < Date.now() / 1000 || typeof f !== 'string') return false;
  const esperada = Buffer.from(firma(archivo, n));
  const recibida = Buffer.from(f);
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

/** Carpetas donde el servicio ANPR guarda la evidencia (según el entorno de ejecución). */
export const DIRECTORIOS_MEDIA = [
  process.env.MEDIA_DIR,
  '/app/media',
  path.resolve(process.cwd(), '../services/anpr/media'),
  path.resolve(process.cwd(), 'services/anpr/media'),
  path.resolve(__dirname, '../../../services/anpr/media'),
].filter(Boolean) as string[];

/** Borra del disco las imágenes de evidencia indicadas. Devuelve cuántos archivos eliminó. */
export async function eliminarEvidencia(rutas: (string | null | undefined)[]): Promise<number> {
  const archivos = [...new Set(rutas.map(archivoDe).filter((a): a is string => Boolean(a)))];
  let borrados = 0;
  for (const archivo of archivos) {
    for (const dir of DIRECTORIOS_MEDIA) {
      try {
        await fs.promises.unlink(path.join(dir, archivo));
        borrados++;
        break;
      } catch { /* no está en esta carpeta */ }
    }
  }
  return borrados;
}
