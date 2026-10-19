import React, { useRef, useState } from 'react';
import { Ban, Camera, Check, Crop, Eraser, Hand, MousePointer2, Plus, Save, Trash2, Undo2, X } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import type { Camara } from '../../dominio/tipos';
import { Aviso, Modal } from './ui';
import { ReproductorWebRTC } from './envivo';
import { Punto } from './hud';

/**
 * Editor de las zonas de una cámara, dibujadas sobre el video en vivo (solo el administrador):
 *  - Área de detección (región de interés, como la máscara de detección de OpenALPR): fuera de
 *    ella el motor no busca placas (vehículos estacionados, la vía pública, rótulos).
 *  - Zonas de exclusión: lo contrario; dentro de ellas no cuenta el movimiento ni se buscan
 *    placas. Se marcan donde hay movimiento falso y no pasan vehículos (árboles, banderas,
 *    reflejos, la vereda, la hora sobreimpresa): así el motor solo se activa con vehículos.
 * Dibujo por vértices con cierre por ajuste al primer punto, edición directa y agregado de puntos
 * sobre el borde. Las coordenadas siempre son relativas al cuadro del flujo principal (0–1).
 */
const MAX_VERTICES = 12;
export const MAX_EXCLUSIONES = 8;
const limitar = (v: number) => Math.min(1, Math.max(0, v));
const redondear = (v: number) => Math.round(v * 10000) / 10000;

type Modo = 'deteccion' | 'exclusion';
type Herramienta = 'seleccionar' | 'rectangulo' | 'poligono';
/** Vértice que se arrastra: zona -1 = área de detección */
interface Arrastre { zona: number; vertice: number }
interface Traslacion { zona: number; inicio: Punto; original: Punto[] }

/** Motivo por el que las zonas no se pueden guardar (null = válidas); las zonas vacías se ignoran. */
export function errorZonas(roi: Punto[], zonas: Punto[][]): string | null {
  if (roi.length > 0 && roi.length < 3) return 'El área de detección necesita al menos 3 vértices (o bórrela para analizar el cuadro completo).';
  if (roi.length >= 3 && !poligonoSimple(roi)) return 'El área de detección se cruza consigo misma o no forma un área válida. Ajuste sus vértices.';
  const incompleta = zonas.findIndex(z => z.length > 0 && z.length < 3);
  if (incompleta >= 0) return `Complete la zona de exclusión ${incompleta + 1} (mínimo 3 vértices) o bórrela.`;
  const invalida = zonas.findIndex(z => z.length >= 3 && !poligonoSimple(z));
  if (invalida >= 0) return `La zona de exclusión ${invalida + 1} se cruza consigo misma o no forma un área válida. Ajuste sus vértices.`;
  return null;
}

const orientacion = (a: Punto, b: Punto, c: Punto) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentosSeCruzan(a: Punto, b: Punto, c: Punto, d: Punto): boolean {
  const abC = orientacion(a, b, c), abD = orientacion(a, b, d);
  const cdA = orientacion(c, d, a), cdB = orientacion(c, d, b);
  const eps = 1e-9;
  const entre = (v: number, x: number, y: number) => v >= Math.min(x, y) - eps && v <= Math.max(x, y) + eps;
  const sobre = (p: Punto, x: Punto, y: Punto) => Math.abs(orientacion(x, y, p)) < eps
    && entre(p[0], x[0], y[0]) && entre(p[1], x[1], y[1]);
  if (((abC > eps && abD < -eps) || (abC < -eps && abD > eps))
    && ((cdA > eps && cdB < -eps) || (cdA < -eps && cdB > eps))) return true;
  return sobre(c, a, b) || sobre(d, a, b) || sobre(a, c, d) || sobre(b, c, d);
}
function poligonoSimple(puntos: Punto[]): boolean {
  let dobleArea = 0;
  for (let i = 0; i < puntos.length; i++) {
    const a = puntos[i], b = puntos[(i + 1) % puntos.length];
    dobleArea += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(dobleArea) < 1e-6) return false;
  for (let i = 0; i < puntos.length; i++) {
    const iSiguiente = (i + 1) % puntos.length;
    for (let j = i + 1; j < puntos.length; j++) {
      const jSiguiente = (j + 1) % puntos.length;
      if (i === j || iSiguiente === j || jSiguiente === i) continue;
      if (segmentosSeCruzan(puntos[i], puntos[iSiguiente], puntos[j], puntos[jSiguiente])) return false;
    }
  }
  return true;
}

const centro = (z: Punto[]): Punto => [z.reduce((s, p) => s + p[0], 0) / z.length, z.reduce((s, p) => s + p[1], 0) / z.length];
const puntosSvg = (z: Punto[]) => z.map(([x, y]) => `${x},${y}`).join(' ');

/** Busca el segmento más cercano al puntero en píxeles, para insertar un vértice con precisión. */
function aristaCercana(puntos: Punto[], p: Punto, ancho: number, alto: number): number {
  if (puntos.length < 2) return -1;
  const px = p[0] * ancho, py = p[1] * alto;
  let minima = 14;
  let indice = -1;
  for (let i = 0; i < puntos.length; i++) {
    const a = puntos[i], b = puntos[(i + 1) % puntos.length];
    const ax = a[0] * ancho, ay = a[1] * alto, bx = b[0] * ancho, by = b[1] * alto;
    const dx = bx - ax, dy = by - ay;
    const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    const distancia = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (distancia < minima) { minima = distancia; indice = i; }
  }
  return indice;
}

export const EditorRoi: React.FC<{ camara: Camara; onCerrar: () => void; onGuardada: (c: Camara) => void }> = ({ camara, onCerrar, onGuardada }) => {
  const [roi, setRoi] = useState<Punto[]>(camara.roi ?? []);
  const [zonas, setZonas] = useState<Punto[][]>(camara.exclusiones ?? []);
  const [modo, setModo] = useState<Modo>('deteccion');
  const [herramienta, setHerramienta] = useState<Herramienta>((camara.roi?.length ?? 0) < 3 ? 'rectangulo' : 'seleccionar');
  const [dibujando, setDibujando] = useState(false);
  const [puntero, setPuntero] = useState<Punto | null>(null);
  const [inicioRectangulo, setInicioRectangulo] = useState<Punto | null>(null);
  const [borradorRectangulo, setBorradorRectangulo] = useState<Punto[] | null>(null);
  // Zona de exclusión en edición (-1: el próximo clic empieza una nueva)
  const [activa, setActiva] = useState(-1);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolucion, setResolucion] = useState<{ ancho: number; alto: number } | null>(null);
  const superficie = useRef<HTMLDivElement>(null);
  const arrastre = useRef<Arrastre | null>(null);
  const traslacion = useRef<Traslacion | null>(null);

  const posicion = (e: React.PointerEvent): Punto => {
    const r = superficie.current!.getBoundingClientRect();
    return [redondear(limitar((e.clientX - r.left) / r.width)), redondear(limitar((e.clientY - r.top) / r.height))];
  };

  const objetivo = modo === 'deteccion' ? roi : activa >= 0 ? zonas[activa] ?? [] : [];
  const actualizarObjetivo = (actualizar: (puntos: Punto[]) => Punto[]) => {
    if (modo === 'deteccion') setRoi(actualizar);
    else if (activa >= 0) setZonas(l => l.map((z, i) => i === activa ? actualizar(z) : z));
  };

  const agregar = (p: Punto) => {
    if (modo === 'deteccion') {
      if (roi.length >= MAX_VERTICES) { setError(`Máximo ${MAX_VERTICES} vértices por zona.`); return; }
      setRoi(l => [...l, p]);
      return;
    }
    if (activa < 0 || activa >= zonas.length) {
      if (zonas.length >= MAX_EXCLUSIONES) { setError(`Máximo ${MAX_EXCLUSIONES} zonas de exclusión.`); return; }
      setZonas(l => [...l, [p]]);
      setActiva(zonas.length);
      return;
    }
    if (zonas[activa].length >= MAX_VERTICES) { setError(`Máximo ${MAX_VERTICES} vértices por zona.`); return; }
    setZonas(l => l.map((z, i) => (i === activa ? [...z, p] : z)));
  };

  const guardarForma = (puntos: Punto[]) => {
    if (modo === 'deteccion') setRoi(puntos);
    else if (activa >= 0) setZonas(l => l.map((z, i) => i === activa ? puntos : z));
  };

  const iniciarTraslacion = (p: Punto, puntos: Punto[]) => {
    traslacion.current = { zona: modo === 'deteccion' ? -1 : activa, inicio: p, original: puntos };
  };

  const alPulsar = (e: React.PointerEvent) => {
    if (arrastre.current !== null || e.button !== 0) return;
    setError(null);
    const p = posicion(e);
    if (herramienta === 'rectangulo') {
      setInicioRectangulo(p);
      setBorradorRectangulo([]);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }
    if (herramienta === 'seleccionar') {
      const r = superficie.current!.getBoundingClientRect();
      const base = modo === 'deteccion' ? roi : activa >= 0 ? zonas[activa] ?? [] : [];
      if (base.length >= 3 && aristaCercana(base, p, r.width, r.height) >= 0) iniciarTraslacion(p, base);
      return;
    }
    if (dibujando) {
      // Doble clic finaliza el polígono; si tiene tres puntos, el segundo evento no agrega otro.
      if (e.detail > 1 && objetivo.length >= 3) {
        setDibujando(false);
        setPuntero(null);
        return;
      }
      if (objetivo.length >= 3) {
        const r = superficie.current!.getBoundingClientRect();
        const primero = objetivo[0];
        if (Math.hypot((p[0] - primero[0]) * r.width, (p[1] - primero[1]) * r.height) <= 16) {
          setDibujando(false);
          setPuntero(null);
          return;
        }
      }
      agregar(p);
      return;
    }

    // Fuera del modo de dibujo, solo un clic sobre un borde inserta un punto: el área no cambia
    // accidentalmente si se pulsa dentro del video para seleccionar otra herramienta.
    const r = superficie.current!.getBoundingClientRect();
    const arista = aristaCercana(objetivo, p, r.width, r.height);
    if (arista >= 0) {
      if (objetivo.length >= MAX_VERTICES) { setError(`Máximo ${MAX_VERTICES} vértices por zona.`); return; }
      actualizarObjetivo(actual => [...actual.slice(0, arista + 1), p, ...actual.slice(arista + 1)]);
    }
  };
  const alMover = (e: React.PointerEvent) => {
    const movimientoFigura = traslacion.current;
    const p = posicion(e);
    if (inicioRectangulo) {
      const x1 = Math.min(inicioRectangulo[0], p[0]), y1 = Math.min(inicioRectangulo[1], p[1]);
      const x2 = Math.max(inicioRectangulo[0], p[0]), y2 = Math.max(inicioRectangulo[1], p[1]);
      setBorradorRectangulo([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
      return;
    }
    if (movimientoFigura) {
      const dx = p[0] - movimientoFigura.inicio[0], dy = p[1] - movimientoFigura.inicio[1];
      const minX = Math.min(...movimientoFigura.original.map(q => q[0]));
      const maxX = Math.max(...movimientoFigura.original.map(q => q[0]));
      const minY = Math.min(...movimientoFigura.original.map(q => q[1]));
      const maxY = Math.max(...movimientoFigura.original.map(q => q[1]));
      const limitadoX = Math.max(-minX, Math.min(1 - maxX, dx));
      const limitadoY = Math.max(-minY, Math.min(1 - maxY, dy));
      const nuevo = movimientoFigura.original.map(([x, y]) => [redondear(x + limitadoX), redondear(y + limitadoY)] as Punto);
      if (movimientoFigura.zona < 0) setRoi(nuevo);
      else setZonas(l => l.map((z, i) => i === movimientoFigura.zona ? nuevo : z));
      return;
    }
    const a = arrastre.current;
    if (!a) { if (dibujando) setPuntero(p); return; }
    if (a.zona < 0) setRoi(l => l.map((q, j) => (j === a.vertice ? p : q)));
    else setZonas(l => l.map((z, i) => (i === a.zona ? z.map((q, j) => (j === a.vertice ? p : q)) : z)));
  };
  const quitarVertice = (zona: number, vertice: number) => {
    if (zona < 0) setRoi(l => l.filter((_, j) => j !== vertice));
    else setZonas(l => l.map((z, i) => (i === zona ? z.filter((_, j) => j !== vertice) : z)));
  };

  const borrarZona = (i: number) => {
    setZonas(l => l.filter((_, j) => j !== i));
    setActiva(-1);
  };
  const deshacer = () => {
    if (modo === 'deteccion') setRoi(l => l.slice(0, -1));
    else if (activa >= 0) setZonas(l => l.map((z, i) => (i === activa ? z.slice(0, -1) : z)));
  };
  const borrar = () => {
    if (modo === 'deteccion') setRoi([]);
    else if (activa >= 0) borrarZona(activa);
  };

  const iniciarDibujo = () => {
    setError(null);
    setPuntero(null);
    if (modo === 'deteccion') setRoi([]);
    else {
      if (zonas.length >= MAX_EXCLUSIONES) { setError(`Máximo ${MAX_EXCLUSIONES} zonas de exclusión.`); return; }
      setZonas(l => [...l, []]);
      setActiva(zonas.length);
    }
    setDibujando(true);
    setHerramienta('poligono');
  };

  const alSoltar = () => {
    if (inicioRectangulo && borradorRectangulo && Math.max(
      Math.abs(borradorRectangulo[2][0] - borradorRectangulo[0][0]),
      Math.abs(borradorRectangulo[2][1] - borradorRectangulo[0][1]),
    ) > 0.008) {
      guardarForma(borradorRectangulo);
      setHerramienta('seleccionar');
    }
    setInicioRectangulo(null);
    setBorradorRectangulo(null);
    traslacion.current = null;
    arrastre.current = null;
  };

  const finalizarDibujo = () => {
    if (objetivo.length < 3) { setError('Marque al menos 3 vértices antes de cerrar el polígono.'); return; }
    setDibujando(false);
    setPuntero(null);
    setError(null);
  };

  const cancelarDibujo = () => {
    if (modo === 'deteccion') setRoi([]);
    else if (activa >= 0) {
      setZonas(l => l.filter((_, i) => i !== activa));
      setActiva(-1);
    }
    setDibujando(false);
    setPuntero(null);
    setError(null);
  };

  const cambiarModo = (nuevo: Modo) => {
    setModo(nuevo);
    setDibujando(false);
    setHerramienta('seleccionar');
    setPuntero(null);
    setError(null);
  };

  const guardar = async () => {
    const problema = errorZonas(roi, zonas);
    if (problema) { setError(problema); return; }
    setGuardando(true);
    setError(null);
    try {
      const r = await api.put(`/camaras/${camara.id}/roi`, { roi: roi.length ? roi : null, exclusiones: zonas.filter(z => z.length > 0) });
      onGuardada(r.data.camera);
    } catch (e) {
      setError(mensajeError(e));
    } finally { setGuardando(false); }
  };

  const exterior = roi.length >= 3 && !(modo === 'deteccion' && dibujando)
    ? `M0 0H1V1H0Z M${roi.map(([x, y]) => `${x} ${y}`).join(' L')} Z` : null;
  const lineaPrevia = dibujando && objetivo.length > 0 && puntero
    ? `${puntosSvg(objetivo)} ${puntero[0]},${puntero[1]}` : null;
  const editables: Arrastre[] = modo === 'deteccion'
    ? herramienta === 'seleccionar' ? roi.map((_, vertice) => ({ zona: -1, vertice })) : []
    : herramienta === 'seleccionar' ? zonas.flatMap((z, zona) => zona === activa ? z.map((_, vertice) => ({ zona, vertice })) : []) : [];
  const puntoDe = (a: Arrastre): Punto => (a.zona < 0 ? roi[a.vertice] : zonas[a.zona][a.vertice]);

  const capa = (
    <div ref={superficie} data-testid="superficie-zonas" onPointerDown={alPulsar} onPointerMove={alMover}
      onPointerUp={alSoltar} onPointerCancel={alSoltar}
      onPointerLeave={() => { if (!arrastre.current) setPuntero(null); }}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' }}>
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {exterior && <path d={exterior} fill="rgba(2,6,23,0.45)" fillRule="evenodd" />}
        {roi.length >= 2 && !(modo === 'deteccion' && (dibujando || herramienta === 'rectangulo' && borradorRectangulo)) && (
          <polygon points={puntosSvg(roi)} fill={roi.length >= 3 ? 'rgba(56,189,248,0.14)' : 'none'} stroke="#7dd3fc"
            strokeWidth={modo === 'deteccion' ? 2.5 : 1.5} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />
        )}
        {modo === 'deteccion' && dibujando && roi.length >= 2 && <polyline points={puntosSvg(roi)} fill="none" stroke="#7dd3fc"
          strokeWidth={2.5} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />}
        {zonas.map((z, i) => z.length >= 2 && <React.Fragment key={i}>
          {!(dibujando && modo === 'exclusion' && i === activa) && !(modo === 'exclusion' && herramienta === 'rectangulo' && i === activa && borradorRectangulo) && <polygon data-testid={`zona-exclusion-${i + 1}`} points={puntosSvg(z)}
            fill={z.length >= 3 ? 'rgba(239,68,68,0.26)' : 'none'} stroke="#f87171"
            strokeWidth={modo === 'exclusion' && i === activa ? 3 : 1.5} vectorEffect="non-scaling-stroke" />}
          {dibujando && modo === 'exclusion' && i === activa && <polyline points={puntosSvg(z)} fill="none" stroke="#f87171"
            strokeWidth={2.5} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />}
        </React.Fragment>)}
        {borradorRectangulo && borradorRectangulo.length === 4 && <polygon points={puntosSvg(borradorRectangulo)} fill="rgba(56,189,248,0.12)"
          stroke={modo === 'deteccion' ? '#38bdf8' : '#f87171'} strokeWidth={2} strokeDasharray="7 4" vectorEffect="non-scaling-stroke" />}
        {lineaPrevia && <polyline points={lineaPrevia} fill="none" stroke={modo === 'deteccion' ? '#7dd3fc' : '#f87171'}
          strokeWidth={1.5} strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />}
      </svg>
      {modo === 'exclusion' && zonas.map((z, i) => z.length >= 3 && (
        <span key={`n${i}`} style={{ position: 'absolute', left: `${centro(z)[0] * 100}%`, top: `${centro(z)[1] * 100}%`, transform: 'translate(-50%, -50%)',
          background: '#b91c1c', color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700, pointerEvents: 'none' }}>{i + 1}</span>
      ))}
      {editables.map(a => {
        const [x, y] = puntoDe(a);
        const exclusion = a.zona >= 0;
        const resaltado = exclusion ? a.zona === activa && a.vertice === 0 : a.vertice === 0;
        return (
          <span key={`${a.zona}:${a.vertice}`} role="button" aria-label={exclusion ? `Zona ${a.zona + 1}, vértice ${a.vertice + 1}` : `Vértice ${a.vertice + 1}`}
            title="Arrastre para mover · doble clic para quitar"
            onPointerDown={e => {
              e.stopPropagation();
              const primeroActivo = a.vertice === 0 && (a.zona < 0 ? modo === 'deteccion' : modo === 'exclusion' && a.zona === activa);
              if (dibujando && primeroActivo && objetivo.length >= 3) {
                setDibujando(false);
                setPuntero(null);
                return;
              }
              if (exclusion) setActiva(a.zona);
              arrastre.current = a;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onDoubleClick={e => {
              e.stopPropagation();
              if (dibujando && objetivo.length >= 3) return;
              quitarVertice(a.zona, a.vertice);
            }}
            style={{ position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`, width: 16, height: 16, marginLeft: -8, marginTop: -8,
              borderRadius: '50%', background: resaltado ? (exclusion ? '#f87171' : '#38bdf8') : '#fff',
              border: `2px solid ${exclusion ? '#b91c1c' : '#0369a1'}`, cursor: dibujando ? (a.vertice === 0 ? 'pointer' : 'crosshair') : 'grab',
              boxShadow: '0 0 0 3px rgba(255,255,255,.2), 0 1px 4px rgba(0,0,0,.5)' }} />
        );
      })}
      {herramienta === 'seleccionar' && objetivo.length >= 3 && <button type="button" aria-label="Mover área" title="Arrastre para mover el área completa"
        onPointerDown={e => { e.stopPropagation(); e.preventDefault(); iniciarTraslacion(posicion(e), objetivo); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
        style={{ position: 'absolute', left: `${centro(objetivo)[0] * 100}%`, top: `${centro(objetivo)[1] * 100}%`, transform: 'translate(-50%,-50%)',
          width: 28, height: 28, display: 'grid', placeItems: 'center', borderRadius: 6, border: '1px solid rgba(255,255,255,.8)',
          color: '#fff', background: modo === 'deteccion' ? '#0369a1' : '#b91c1c', boxShadow: '0 1px 6px #0008', cursor: 'move', pointerEvents: 'auto' }}><Hand size={15} /></button>}
    </div>
  );

  return (
    <Modal titulo={`Zonas · ${camara.nombre}`} subtitulo="Dónde busca placas el motor y dónde ignora el movimiento" onCerrar={onCerrar} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={guardando}>Cancelar</button>
        <button className="btn btn-navy" onClick={guardar} disabled={guardando || dibujando}>
          <Save size={14} /> {guardando ? 'Guardando…' : 'Guardar zonas'}</button>
      </>}>
      <div className="pila" style={{ gap: 12 }}>
        <div className="fila" role="group" aria-label="Qué se dibuja" style={{ gap: 8 }}>
          <button className={`btn btn-sm ${modo === 'deteccion' ? 'btn-navy' : 'btn-secondary'}`} aria-pressed={modo === 'deteccion'}
            onClick={() => cambiarModo('deteccion')}><Crop size={14} /> Área de detección</button>
          <button className={`btn btn-sm ${modo === 'exclusion' ? 'btn-navy' : 'btn-secondary'}`} aria-pressed={modo === 'exclusion'}
            onClick={() => cambiarModo('exclusion')}><Ban size={14} /> Zonas de exclusión ({zonas.filter(z => z.length >= 3).length})</button>
        </div>
        <div className="fila" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <span className="texto-secundario">
            {herramienta === 'rectangulo' ? 'Haga clic y arrastre para dibujar la figura.'
              : herramienta === 'poligono' ? 'Coloque vértices y cierre haciendo clic en el primero o con doble clic.'
                : 'Seleccione para mover la figura completa o arrastre sus vértices para ajustarla.'}
          </span>
          <span className="fila" style={{ gap: 6 }}>
            <button className={`btn btn-secondary btn-sm ${herramienta === 'seleccionar' ? 'activo' : ''}`} aria-pressed={herramienta === 'seleccionar'}
              onClick={() => { setHerramienta('seleccionar'); setDibujando(false); setPuntero(null); }}><MousePointer2 size={14} /> Seleccionar / mover</button>
            <button className={`btn btn-secondary btn-sm ${herramienta === 'rectangulo' ? 'activo' : ''}`} aria-pressed={herramienta === 'rectangulo'}
              onClick={() => { setHerramienta('rectangulo'); setDibujando(false); setPuntero(null); }}><Crop size={14} /> Rectángulo</button>
            {dibujando ? <>
              <button className="btn btn-secondary btn-sm" onClick={finalizarDibujo} disabled={objetivo.length < 3}><Check size={14} /> Cerrar polígono</button>
              <button className="btn btn-ghost btn-sm" onClick={cancelarDibujo}><X size={14} /> Cancelar dibujo</button>
            </> : <button className="btn btn-secondary btn-sm" onClick={iniciarDibujo}
              disabled={modo === 'exclusion' && zonas.length >= MAX_EXCLUSIONES}>
              <Plus size={14} /> {modo === 'deteccion' ? 'Polígono' : 'Nuevo polígono'}
            </button>}
          </span>
        </div>
        <Aviso tipo="info">
          {modo === 'deteccion'
            ? <>Use <b>Rectángulo</b> y arrastre sobre el carril, o elija <b>Polígono</b> para una forma irregular. En Seleccionar puede mover la figura con la mano o ajustar vértices. El motor busca placas dentro del área; sin área analiza el cuadro completo.</>
            : <>Dibuje zonas con <b>movimiento falso</b> con rectángulo arrastrando o con polígono. Seleccione y mueva la figura con la mano; dentro de esas áreas el motor ignora movimiento y no busca placas.</>}
        </Aviso>
        <ReproductorWebRTC etiqueta="ZONAS" capa={capa}
          onEstadisticas={s => {
            if (s && s.ancho > 0 && s.alto > 0) setResolucion({ ancho: s.ancho, alto: s.alto });
          }}
          obtener={async () => {
            const r = (await api.post(`/camaras/${camara.id}/video`)).data;
            // Las zonas se aplican sobre el flujo principal que procesa el motor ANPR.
            return { whep: `${r.webrtc}/${r.ruta}/whep?ticket=${encodeURIComponent(r.ticket)}` };
          }} onFallo={m => setError(m)} />
        <div className="fila" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="insignia"><Camera size={13} /> Flujo principal · cuadro que procesa ANPR</span>
          {resolucion && <span className="insignia" title="Dimensiones detectadas del flujo principal">
            Cuadro detectado: {resolucion.ancho} × {resolucion.alto} · {resolucion.ancho === resolucion.alto ? 'cuadrado' : resolucion.ancho > resolucion.alto ? 'horizontal' : 'vertical'}
          </span>}
          <span className="texto-secundario">Las zonas se guardan en coordenadas relativas al cuadro.</span>
        </div>
        {(camara.roi?.length || camara.exclusiones?.length) ? <Aviso tipo="advertencia">
          Revise las zonas guardadas sobre este flujo principal y ajústelas si fueron dibujadas sobre un flujo secundario con otro encuadre.
        </Aviso> : null}
        {modo === 'exclusion' && (
          <div className="fila" style={{ gap: 6, flexWrap: 'wrap' }}>
            {zonas.map((z, i) => (
              <span key={i} className={`insignia ${i === activa ? 'alerta' : ''}`} style={{ gap: 6 }}>
                <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} aria-pressed={i === activa}
                  onClick={() => { setActiva(i); setDibujando(false); setPuntero(null); }}>Zona {i + 1} · {z.length} {z.length === 1 ? 'vértice' : 'vértices'}</button>
                <button type="button" className="btn btn-ghost btn-sm btn-icono" aria-label={`Borrar zona ${i + 1}`} title="Borrar la zona"
                  onClick={() => borrarZona(i)}><Trash2 size={13} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="fila" style={{ justifyContent: 'space-between' }}>
          <span className="texto-secundario">
            {modo === 'deteccion'
              ? (roi.length === 0 ? 'Sin área: se analiza el cuadro completo.' : `${roi.length} ${roi.length === 1 ? 'vértice' : 'vértices'}${roi.length < 3 ? ' (mínimo 3)' : ''}`)
              : (activa >= 0 && zonas[activa] ? `Editando la zona ${activa + 1}: ${zonas[activa].length} vértices${zonas[activa].length < 3 ? ' (mínimo 3)' : ''}`
                : 'Haga clic sobre el video para empezar una zona nueva.')}
          </span>
          <span className="fila" style={{ gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={deshacer} disabled={!objetivo.length}><Undo2 size={14} /> Deshacer</button>
            <button className="btn btn-ghost btn-sm" onClick={borrar} disabled={!objetivo.length}><Eraser size={14} /> {modo === 'deteccion' ? 'Borrar área' : 'Borrar zona'}</button>
          </span>
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
    </Modal>
  );
};
