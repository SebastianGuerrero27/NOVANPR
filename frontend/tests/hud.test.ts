/**
 * Alineación de los recuadros del motor con el video: el motor envía coordenadas normalizadas
 * (0–1) del cuadro que analizó; el HUD las dibuja dentro del área donde realmente se ve la imagen
 * (sin las franjas negras de object-fit: contain), para cualquier tamaño o proporción.
 */
import { describe, expect, it, vi } from 'vitest';
import { aPantalla, areaVideo, crearHud, dibujarExclusiones } from '../src/interfaz/componentes/hud';

const video = (ancho: number, alto: number, vw: number, vh: number) =>
  ({ getBoundingClientRect: () => ({ width: ancho, height: alto }), videoWidth: vw, videoHeight: vh }) as unknown as HTMLVideoElement;

const cerca = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 4));

describe('HUD · alineación de los recuadros', () => {
  it('video 16:9 en un reproductor 16:9: el área es todo el lienzo', () => {
    expect(areaVideo(video(1280, 720, 1920, 1080))).toEqual({ ancho: 1280, alto: 720, x: 0, y: 0, w: 1280, h: 720 });
  });

  it('reproductor más ancho que el video: franjas a los lados y el recuadro no cae sobre ellas', () => {
    const a = areaVideo(video(1000, 400, 1920, 1080));
    cerca([a.x, a.y, a.w, a.h], [144.4444, 0, 711.1111, 400]);
    cerca(aPantalla(a, 0, 0), [144.4444, 0]);
    cerca(aPantalla(a, 1, 1), [855.5556, 400]);
  });

  it('reproductor más alto que el video: franjas arriba y abajo', () => {
    const a = areaVideo(video(600, 600, 1920, 1080));
    cerca([a.x, a.y, a.w, a.h], [0, 131.25, 600, 337.5]);
  });

  it('al redimensionar el reproductor, la misma caja queda sobre el mismo punto de la imagen', () => {
    const caja = [0.4, 0.55, 0.6, 0.65];
    for (const [ancho, alto] of [[1280, 720], [640, 360], [1000, 400], [500, 800]]) {
      const a = areaVideo(video(ancho, alto, 1920, 1080));
      const [x1, y1] = aPantalla(a, caja[0], caja[1]);
      const [x2, y2] = aPantalla(a, caja[2], caja[3]);
      // Posición relativa dentro de la imagen visible: idéntica para cualquier tamaño
      cerca([(x1 - a.x) / a.w, (y1 - a.y) / a.h, (x2 - a.x) / a.w, (y2 - a.y) / a.h], caja);
    }
  });

  it('vista de otra proporción (secundario 640×480 de un sensor 16:9): se dibuja con la proporción del motor', () => {
    // El reproductor adopta la proporción del motor y estira la imagen (object-fit: fill)
    expect(areaVideo(video(1280, 720, 640, 480), 16 / 9)).toEqual({ ancho: 1280, alto: 720, x: 0, y: 0, w: 1280, h: 720 });
  });

  it('las zonas de exclusión se dibujan dentro del área visible (con franjas laterales) y se omiten las incompletas', () => {
    const trazos: [string, number, number][] = [];
    const ctx = {
      beginPath: () => undefined, closePath: () => undefined, fill: () => undefined, stroke: () => undefined, setLineDash: () => undefined,
      moveTo: (x: number, y: number) => trazos.push(['moveTo', x, y]), lineTo: (x: number, y: number) => trazos.push(['lineTo', x, y]),
    } as unknown as CanvasRenderingContext2D;
    const a = areaVideo(video(1000, 400, 1920, 1080));
    dibujarExclusiones(ctx, a, [[[0, 0], [1, 0], [1, 1]], [[0.5, 0.5], [0.6, 0.5]]]);
    expect(trazos).toHaveLength(3);
    cerca(trazos.map(t => t[1]), [144.4444, 855.5556, 855.5556]);
    cerca(trazos.map(t => t[2]), [0, 0, 400]);
  });

  it('al cerrarse las pistas del motor (limpiar), no quedan pintadas la región ni las zonas de exclusión', () => {
    let cuadro: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { cuadro = f; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const trazos: string[] = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' && ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textBaseline', 'globalAlpha'].includes(k)
        ? undefined : () => { trazos.push(String(k)); return { width: 10 }; }),
      set: () => true,
    });
    const lienzo = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const hud = crearHud(lienzo, () => ({ ancho: 100, alto: 100, x: 0, y: 0, w: 100, h: 100 }));
    const dibujar = () => { trazos.length = 0; (cuadro as unknown as (t: number) => void)(0); return trazos.filter(t => t === 'moveTo' || t === 'lineTo').length; };
    hud.actualizar([], null, [[0, 0], [1, 0], [1, 1]], [[[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]]]);
    expect(dibujar()).toBeGreaterThan(0);
    hud.limpiar();
    expect(dibujar()).toBe(0);
    hud.detener();
    vi.unstubAllGlobals();
  });

  it('sin dimensiones del video todavía, usa 16:9 por omisión', () => {
    const a = areaVideo(video(1280, 720, 0, 0));
    expect([a.w, a.h]).toEqual([1280, 720]);
  });
});
