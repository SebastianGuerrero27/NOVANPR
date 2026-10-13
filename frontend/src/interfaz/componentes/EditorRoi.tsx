import React, { useRef, useState } from 'react';
import { Ban, Crop, Eraser, Plus, Save, Trash2, Undo2 } from 'lucide-react';
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
 * Clic para agregar un vértice, arrastrar para moverlo, doble clic sobre un vértice para quitarlo.
 */
const MAX_VERTICES = 12;
export const MAX_EXCLUSIONES = 8;
const limitar = (v: number) => Math.min(1, Math.max(0, v));
const redondear = (v: number) => Math.round(v * 10000) / 10000;

type Modo = 'deteccion' | 'exclusion';
/** Vértice que se arrastra: zona -1 = área de detección */
interface Arrastre { zona: number; vertice: number }

/** Motivo por el que las zonas no se pueden guardar (null = válidas); las zonas vacías se ignoran. */
export function errorZonas(roi: Punto[], zonas: Punto[][]): string | null {
  if (roi.length > 0 && roi.length < 3) return 'El área de detección necesita al menos 3 vértices (o bórrela para analizar el cuadro completo).';
  const incompleta = zonas.findIndex(z => z.length > 0 && z.length < 3);
  if (incompleta >= 0) return `Complete la zona de exclusión ${incompleta + 1} (mínimo 3 vértices) o bórrela.`;
  return null;
}

const centro = (z: Punto[]): Punto => [z.reduce((s, p) => s + p[0], 0) / z.length, z.reduce((s, p) => s + p[1], 0) / z.length];
const puntosSvg = (z: Punto[]) => z.map(([x, y]) => `${x},${y}`).join(' ');

export const EditorRoi: React.FC<{ camara: Camara; onCerrar: () => void; onGuardada: (c: Camara) => void }> = ({ camara, onCerrar, onGuardada }) => {
  const [roi, setRoi] = useState<Punto[]>(camara.roi ?? []);
  const [zonas, setZonas] = useState<Punto[][]>(camara.exclusiones ?? []);
  const [modo, setModo] = useState<Modo>('deteccion');
  // Zona de exclusión en edición (-1: el próximo clic empieza una nueva)
  const [activa, setActiva] = useState(-1);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const superficie = useRef<HTMLDivElement>(null);
  const arrastre = useRef<Arrastre | null>(null);

  const posicion = (e: React.PointerEvent): Punto => {
    const r = superficie.current!.getBoundingClientRect();
    return [redondear(limitar((e.clientX - r.left) / r.width)), redondear(limitar((e.clientY - r.top) / r.height))];
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

  const alPulsar = (e: React.PointerEvent) => {
    if (arrastre.current !== null || e.button !== 0) return;
    setError(null);
    agregar(posicion(e));
  };
  const alMover = (e: React.PointerEvent) => {
    const a = arrastre.current;
    if (!a) return;
    const p = posicion(e);
    if (a.zona < 0) setRoi(l => l.map((q, j) => (j === a.vertice ? p : q)));
    else setZonas(l => l.map((z, i) => (i === a.zona ? z.map((q, j) => (j === a.vertice ? p : q)) : z)));
  };
  const quitarVertice = (zona: number, vertice: number) => {
    if (zona < 0) setRoi(l => l.filter((_, j) => j !== vertice));
    else setZonas(l => l.map((z, i) => (i === zona ? z.filter((_, j) => j !== vertice) : z)));
  };

  const nuevaZona = () => {
    if (zonas.length >= MAX_EXCLUSIONES) { setError(`Máximo ${MAX_EXCLUSIONES} zonas de exclusión.`); return; }
    setError(null);
    setZonas(l => [...l, []]);
    setActiva(zonas.length);
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

  const exterior = roi.length >= 3 ? `M0 0H1V1H0Z M${roi.map(([x, y]) => `${x} ${y}`).join(' L')} Z` : null;
  const editables: Arrastre[] = modo === 'deteccion'
    ? roi.map((_, vertice) => ({ zona: -1, vertice }))
    : zonas.flatMap((z, zona) => z.map((_, vertice) => ({ zona, vertice })));
  const puntoDe = (a: Arrastre): Punto => (a.zona < 0 ? roi[a.vertice] : zonas[a.zona][a.vertice]);

  const capa = (
    <div ref={superficie} data-testid="superficie-zonas" onPointerDown={alPulsar} onPointerMove={alMover}
      onPointerUp={() => { arrastre.current = null; }} onPointerLeave={() => { arrastre.current = null; }}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' }}>
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {exterior && <path d={exterior} fill="rgba(2,6,23,0.45)" fillRule="evenodd" />}
        {roi.length >= 2 && (
          <polygon points={puntosSvg(roi)} fill={roi.length >= 3 ? 'rgba(56,189,248,0.14)' : 'none'} stroke="#7dd3fc"
            strokeWidth={modo === 'deteccion' ? 2.5 : 1.5} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />
        )}
        {zonas.map((z, i) => z.length >= 2 && (
          <polygon key={i} data-testid={`zona-exclusion-${i + 1}`} points={puntosSvg(z)} fill={z.length >= 3 ? 'rgba(239,68,68,0.26)' : 'none'}
            stroke="#f87171" strokeWidth={modo === 'exclusion' && i === activa ? 3 : 1.5} vectorEffect="non-scaling-stroke" />
        ))}
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
              if (exclusion) setActiva(a.zona);
              arrastre.current = a;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onDoubleClick={e => { e.stopPropagation(); quitarVertice(a.zona, a.vertice); }}
            style={{ position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`, width: 16, height: 16, marginLeft: -8, marginTop: -8,
              borderRadius: '50%', background: resaltado ? (exclusion ? '#f87171' : '#38bdf8') : '#fff',
              border: `2px solid ${exclusion ? '#b91c1c' : '#0369a1'}`, cursor: 'grab', boxShadow: '0 1px 4px rgba(0,0,0,.5)' }} />
        );
      })}
    </div>
  );

  const objetivo = modo === 'deteccion' ? roi : activa >= 0 ? zonas[activa] ?? [] : [];

  return (
    <Modal titulo={`Zonas · ${camara.nombre}`} subtitulo="Dónde busca placas el motor y dónde ignora el movimiento" onCerrar={onCerrar} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={guardando}>Cancelar</button>
        <button className="btn btn-navy" onClick={guardar} disabled={guardando}>
          <Save size={14} /> {guardando ? 'Guardando…' : 'Guardar zonas'}</button>
      </>}>
      <div className="pila" style={{ gap: 12 }}>
        <div className="fila" role="group" aria-label="Qué se dibuja" style={{ gap: 8 }}>
          <button className={`btn btn-sm ${modo === 'deteccion' ? 'btn-navy' : 'btn-secondary'}`} aria-pressed={modo === 'deteccion'}
            onClick={() => { setModo('deteccion'); setError(null); }}><Crop size={14} /> Área de detección</button>
          <button className={`btn btn-sm ${modo === 'exclusion' ? 'btn-navy' : 'btn-secondary'}`} aria-pressed={modo === 'exclusion'}
            onClick={() => { setModo('exclusion'); setError(null); }}><Ban size={14} /> Zonas de exclusión ({zonas.filter(z => z.length >= 3).length})</button>
        </div>
        <Aviso tipo="info">
          {modo === 'deteccion'
            ? <>Haga <b>clic sobre el video</b> para marcar el área por donde pasan los vehículos (por ejemplo, el carril de ingreso). Fuera de ella no se
              buscan placas y el detector analiza solo ese recorte, con más detalle para las placas lejanas. Sin área se analiza el cuadro completo.</>
            : <>Marque las zonas que producen <b>movimiento falso</b> y por donde no pasan vehículos: árboles, banderas, reflejos, la vereda o la hora
              sobreimpresa. Dentro de ellas no cuenta el movimiento ni se buscan placas, así el motor solo se activa cuando entra un vehículo.</>}
        </Aviso>
        <ReproductorWebRTC etiqueta="ZONAS" capa={capa}
          obtener={async () => {
            const r = (await api.post(`/camaras/${camara.id}/video`)).data;
            // El flujo secundario muestra la misma escena (los vértices son normalizados)
            return { whep: `${r.webrtc}/${r.ruta_vista ?? r.ruta}/whep?ticket=${encodeURIComponent(r.ticket)}` };
          }} onFallo={m => setError(m)} />
        {modo === 'exclusion' && (
          <div className="fila" style={{ gap: 6, flexWrap: 'wrap' }}>
            {zonas.map((z, i) => (
              <span key={i} className={`insignia ${i === activa ? 'alerta' : ''}`} style={{ gap: 6 }}>
                <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} aria-pressed={i === activa}
                  onClick={() => setActiva(i)}>Zona {i + 1} · {z.length} {z.length === 1 ? 'vértice' : 'vértices'}</button>
                <button type="button" className="btn btn-ghost btn-sm btn-icono" aria-label={`Borrar zona ${i + 1}`} title="Borrar la zona"
                  onClick={() => borrarZona(i)}><Trash2 size={13} /></button>
              </span>
            ))}
            <button className="btn btn-secondary btn-sm" onClick={nuevaZona} disabled={zonas.length >= MAX_EXCLUSIONES}><Plus size={14} /> Nueva zona</button>
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
