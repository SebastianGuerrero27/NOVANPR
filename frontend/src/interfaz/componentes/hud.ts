import { formatearPlacaParcial } from '../../dominio/validacion';

/**
 * HUD de detección sobre el video, al estilo Rekor Scout / OpenALPR:
 *  - zona de movimiento MOG2 (verde translúcido) cuando el motor confirma un vehículo en ella;
 *  - caja de cada placa en seguimiento desde el primer cuadro, con el cuadrilátero de 4 vértices
 *    ajustado a la inclinación de la placa;
 *  - insignia con la lectura: "◌ ESCANEANDO OCR" o el texto parcial mientras el OCR lee, la placa
 *    por consenso al leerla y el estado decidido por el backend; barra de escaneo mientras lee.
 *
 * Dibuja con requestAnimationFrame: entre dos envíos del motor extrapola la caja con la velocidad
 * del filtro de Kalman (máx. 80 ms) y desvanece las pistas que dejan de llegar. Sin pistas ni
 * movimiento no vuelve a dibujar hasta el próximo envío.
 *
 * Coordenadas normalizadas 0–1 respecto del cuadro de la fuente.
 */

export type Punto = [number, number];
type Caja = [number, number, number, number];

export interface PistaHud {
  id: number;
  caja: Caja;
  puntos: Punto[] | null;
  /** Fracción del cuadro por segundo */
  velocidad: [number, number];
  /** Confianza del detector (0–1) */
  confianza: number;
  /** Placa por consenso (formato ANT), o null mientras se lee */
  placa: string | null;
  /** Lectura cruda del OCR que aún no forma una placa */
  parcial: string | null;
  confianzaPlaca: number;
  estado: string | null;
}

export interface MovimientoHud { caja: Caja; porcentaje: number }

/** Rectángulo de la imagen dentro del elemento (object-fit: contain), en píxeles CSS. */
export interface AreaDibujo { ancho: number; alto: number; x: number; y: number; w: number; h: number }

export function areaVideo(v: HTMLVideoElement): AreaDibujo {
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 16;
  const vh = v.videoHeight || 9;
  const esc = Math.min(r.width / vw, r.height / vh);
  return { ancho: r.width, alto: r.height, x: (r.width - vw * esc) / 2, y: (r.height - vh * esc) / 2, w: vw * esc, h: vh * esc };
}

// Colores iguales a los del motor y del sistema web
const COLOR_ESTADO: Record<string, string> = {
  autorizado: '#15803d', pendiente_revision: '#2563eb', no_reconocido: '#d97706', alerta: '#b91c1c',
};
const TEXTO_ESTADO: Record<string, string> = {
  autorizado: 'AUTORIZADO', pendiente_revision: 'POR CONFIRMAR', no_reconocido: 'NO REGISTRADO', alerta: 'ALERTA',
};
const COLOR_ESCANEANDO = '#f59e0b';
const COLOR_LEIDA = '#22c55e';

const DESVANECER_PISTA_MS = 400;
const VIDA_MOVIMIENTO_MS = 600;
const ANTICIPACION_MAX_S = 0.08;

function conAlfa(hex: string, alfa: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

function textoInsignia(p: PistaHud): string {
  if (p.placa) {
    const estado = p.estado ? TEXTO_ESTADO[p.estado] : undefined;
    return `${formatearPlacaParcial(p.placa)}  •  ${estado ?? `${Math.round(p.confianzaPlaca * 100)}%`}`;
  }
  const pct = `${Math.round(p.confianza * 100)}%`;
  return p.parcial && p.parcial.length >= 3 ? `◌ ${formatearPlacaParcial(p.parcial)}  •  ${pct}` : `◌ ESCANEANDO OCR  •  ${pct}`;
}

function colorPista(p: PistaHud): string {
  if (p.estado && COLOR_ESTADO[p.estado]) return COLOR_ESTADO[p.estado];
  return p.placa ? COLOR_LEIDA : COLOR_ESCANEANDO;
}

function dibujarRoi(ctx: CanvasRenderingContext2D, a: AreaDibujo, roi: Punto[]) {
  const X = (x: number) => a.x + x * a.w;
  const Y = (y: number) => a.y + y * a.h;
  ctx.beginPath();
  ctx.rect(a.x, a.y, a.w, a.h);
  roi.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
  ctx.closePath();
  ctx.fillStyle = 'rgba(2,6,23,0.38)';
  ctx.fill('evenodd');
  ctx.beginPath();
  roi.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
  ctx.closePath();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = 'rgba(125,211,252,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function dibujarMovimiento(ctx: CanvasRenderingContext2D, a: AreaDibujo, m: MovimientoHud, edadMs: number) {
  const x1 = a.x + m.caja[0] * a.w;
  const y1 = a.y + m.caja[1] * a.h;
  const w = Math.max(12, (m.caja[2] - m.caja[0]) * a.w);
  const h = Math.max(12, (m.caja[3] - m.caja[1]) * a.h);
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - edadMs / VIDA_MOVIMIENTO_MS) * 0.7;
  ctx.fillStyle = 'rgba(34, 197, 94, 0.10)';
  ctx.fillRect(x1, y1, w, h);
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.65)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);
  const texto = `VEHÍCULO • MOV ${m.porcentaje}%`;
  ctx.font = 'bold 10px Inter, system-ui, monospace';
  const by = Math.max(a.y + 4, y1 - 18);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fillRect(x1, by, ctx.measureText(texto).width + 14, 16);
  ctx.fillStyle = '#4ade80';
  ctx.fillText(texto, x1 + 7, by + 11.5);
  ctx.restore();
}

function dibujarPista(ctx: CanvasRenderingContext2D, a: AreaDibujo, p: PistaHud, dx: number, dy: number, opacidad: number, ahora: number) {
  const X = (x: number) => a.x + (x + dx) * a.w;
  const Y = (y: number) => a.y + (y + dy) * a.h;
  const color = colorPista(p);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacidad));
  ctx.shadowColor = conAlfa(color, 0.45);
  ctx.shadowBlur = 10;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;

  let ancla: [number, number];
  if (p.puntos && p.puntos.length === 4) {
    // Cuadrilátero de 4 vértices ajustado a la inclinación de la placa
    const pts = p.puntos.map(([x, y]) => [X(x), Y(y)] as Punto);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = conAlfa(color, 0.12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    pts.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); });
    ancla = [pts.reduce((s, q) => s + q[0], 0) / 4, Math.min(...pts.map(q => q[1]))];
  } else {
    // Caja ortogonal con esquinas tácticas
    const x1 = X(p.caja[0]), y1 = Y(p.caja[1]);
    const x2 = Math.max(x1 + 16, X(p.caja[2])), y2 = Math.max(y1 + 10, Y(p.caja[3]));
    ctx.beginPath();
    ctx.roundRect(x1, y1, x2 - x1, y2 - y1, 4);
    ctx.stroke();
    const l = Math.min(12, (x2 - x1) * 0.22, (y2 - y1) * 0.22);
    ctx.lineWidth = 3.5;
    for (const [cx, cy, sx, sy] of [[x1, y1, 1, 1], [x2, y1, -1, 1], [x1, y2, 1, -1], [x2, y2, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * l);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * l, cy);
      ctx.stroke();
    }
    ancla = [(x1 + x2) / 2, y1];
  }

  // Insignia con la lectura del OCR encima de la placa
  const texto = textoInsignia(p);
  ctx.font = 'bold 13px Inter, system-ui, monospace';
  const bw = ctx.measureText(texto).width + 24;
  const bh = 22;
  const bx = Math.max(a.x + 4, Math.min(a.x + a.w - bw - 4, ancla[0] - bw / 2));
  const by = Math.max(a.y + 4, ancla[1] - 28);
  ctx.shadowBlur = 6;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.fillStyle = 'rgba(11, 19, 43, 0.92)';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(bx + 10, by + bh / 2, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(texto, bx + 18, by + 15);

  // Barra de escaneo pulsante mientras el OCR todavía no tiene la placa
  if (!p.placa) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(bx, by + bh + 2, bw, 3);
    ctx.fillStyle = `rgba(245, 158, 11, ${0.5 + 0.5 * Math.sin(ahora / 200)})`;
    ctx.fillRect(bx, by + bh + 2, bw * ((ahora / 800) % 1), 3);
  }
  ctx.restore();
}

export interface Hud {
  /** Pistas y zona de movimiento del último envío del motor (y la región de interés, si se conoce). */
  actualizar: (pistas: PistaHud[], movimiento: MovimientoHud | null, roi?: Punto[] | null) => void;
  limpiar: () => void;
  detener: () => void;
}

export function crearHud(lienzo: HTMLCanvasElement, area: () => AreaDibujo | null): Hud {
  const pistas = new Map<number, { p: PistaHud; recibida: number; opacidad: number }>();
  let movimiento: { m: MovimientoHud; recibido: number } | null = null;
  let roi: Punto[] | null = null;
  let pendiente = true;
  let ultimaArea = '';
  let previo = performance.now();
  let raf = 0;

  const cuadro = () => {
    raf = requestAnimationFrame(cuadro);
    const ahora = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (ahora - previo) / 1000));
    previo = ahora;
    const a = area();
    const claveArea = a ? `${a.ancho}x${a.alto}:${a.x},${a.y},${a.w},${a.h}` : '';
    if (!pendiente && pistas.size === 0 && !movimiento && claveArea === ultimaArea) return;
    pendiente = false;
    ultimaArea = claveArea;

    const ctx = lienzo.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (!a) { ctx.clearRect(0, 0, lienzo.width, lienzo.height); return; }
    if (lienzo.width !== Math.round(a.ancho * dpr) || lienzo.height !== Math.round(a.alto * dpr)) {
      lienzo.width = Math.round(a.ancho * dpr);
      lienzo.height = Math.round(a.alto * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, a.ancho, a.alto);

    if (roi && roi.length >= 3) dibujarRoi(ctx, a, roi);
    if (movimiento) {
      const edad = ahora - movimiento.recibido;
      if (edad >= VIDA_MOVIMIENTO_MS) movimiento = null;
      else dibujarMovimiento(ctx, a, movimiento.m, edad);
    }
    for (const [id, t] of pistas) {
      if (ahora - t.recibida > DESVANECER_PISTA_MS) {
        t.opacidad -= dt * 3.5;
        if (t.opacidad <= 0) { pistas.delete(id); continue; }
      }
      // Extrapolación con la velocidad de Kalman para que la caja no se quede atrás del video
      const anticipo = Math.min(ANTICIPACION_MAX_S, (ahora - t.recibida) / 1000);
      dibujarPista(ctx, a, t.p, t.p.velocidad[0] * anticipo, t.p.velocidad[1] * anticipo, t.opacidad, ahora);
    }
  };
  raf = requestAnimationFrame(cuadro);

  return {
    actualizar(nuevas, mov, nuevoRoi) {
      const ahora = performance.now();
      for (const p of nuevas) pistas.set(p.id, { p, recibida: ahora, opacidad: 1 });
      if (mov) movimiento = { m: mov, recibido: ahora };
      if (nuevoRoi !== undefined) roi = nuevoRoi;
      pendiente = true;
    },
    limpiar() {
      pistas.clear();
      movimiento = null;
      roi = null;
      pendiente = true;
    },
    detener() { cancelAnimationFrame(raf); },
  };
}
