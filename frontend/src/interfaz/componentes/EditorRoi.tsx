import React, { useRef, useState } from 'react';
import { Eraser, Maximize, Save, Undo2 } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import type { Camara } from '../../dominio/tipos';
import { Aviso, Modal } from './ui';
import { Punto, ReproductorWebRTC } from './envivo';

/**
 * Editor de la región de interés de una cámara (equivalente a la máscara de detección de
 * OpenALPR). Se dibuja sobre el video en vivo: clic para agregar un vértice, arrastrar para
 * moverlo, doble clic sobre un vértice para quitarlo. Fuera del polígono el motor no busca
 * placas, lo que evita lecturas de vehículos estacionados, de la vía pública o de rótulos.
 */
const MAX_VERTICES = 12;
const limitar = (v: number) => Math.min(1, Math.max(0, v));

export const EditorRoi: React.FC<{ camara: Camara; onCerrar: () => void; onGuardada: (c: Camara) => void }> = ({ camara, onCerrar, onGuardada }) => {
  const [puntos, setPuntos] = useState<Punto[]>(camara.roi ?? []);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const superficie = useRef<HTMLDivElement>(null);
  const arrastre = useRef<number | null>(null);

  const posicion = (e: React.PointerEvent): Punto => {
    const r = superficie.current!.getBoundingClientRect();
    return [limitar((e.clientX - r.left) / r.width), limitar((e.clientY - r.top) / r.height)];
  };

  const alPulsar = (e: React.PointerEvent) => {
    if (arrastre.current !== null || e.button !== 0) return;
    if (puntos.length >= MAX_VERTICES) { setError(`Máximo ${MAX_VERTICES} vértices.`); return; }
    setError(null);
    const p = posicion(e);
    setPuntos(l => [...l, [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]]);
  };
  const alMover = (e: React.PointerEvent) => {
    const i = arrastre.current;
    if (i === null) return;
    const p = posicion(e);
    setPuntos(l => l.map((q, j) => (j === i ? [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000] : q)));
  };

  const guardar = async (roi: Punto[] | null) => {
    if (roi && roi.length < 3) { setError('Marque al menos 3 vértices o use el cuadro completo.'); return; }
    setGuardando(true);
    setError(null);
    try {
      const r = await api.put(`/camaras/${camara.id}/roi`, { roi });
      onGuardada(r.data.camera);
    } catch (e) {
      setError(mensajeError(e));
    } finally { setGuardando(false); }
  };

  const trazo = puntos.map(([x, y]) => `${x},${y}`).join(' ');
  const exterior = puntos.length >= 3 ? `M0 0H1V1H0Z M${puntos.map(([x, y]) => `${x} ${y}`).join(' L')} Z` : null;

  const capa = (
    <div ref={superficie} onPointerDown={alPulsar} onPointerMove={alMover}
      onPointerUp={() => { arrastre.current = null; }} onPointerLeave={() => { arrastre.current = null; }}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' }}>
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {exterior && <path d={exterior} fill="rgba(2,6,23,0.45)" fillRule="evenodd" />}
        {puntos.length >= 2 && (
          <polygon points={trazo} fill={puntos.length >= 3 ? 'rgba(56,189,248,0.14)' : 'none'} stroke="#7dd3fc" strokeWidth={2}
            strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {puntos.map(([x, y], i) => (
        <span key={i} role="button" aria-label={`Vértice ${i + 1}`} title="Arrastre para mover · doble clic para quitar"
          onPointerDown={e => { e.stopPropagation(); arrastre.current = i; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
          onDoubleClick={e => { e.stopPropagation(); setPuntos(l => l.filter((_, j) => j !== i)); }}
          style={{ position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`, width: 16, height: 16, marginLeft: -8, marginTop: -8,
            borderRadius: '50%', background: i === 0 ? '#38bdf8' : '#fff', border: '2px solid #0369a1', cursor: 'grab',
            boxShadow: '0 1px 4px rgba(0,0,0,.5)' }} />
      ))}
    </div>
  );

  return (
    <Modal titulo={`Área de interés · ${camara.nombre}`} subtitulo="Zona del cuadro donde el motor ANPR busca placas" onCerrar={onCerrar} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={guardando}>Cancelar</button>
        <button className="btn btn-secondary" onClick={() => guardar(null)} disabled={guardando} title="Quitar la región: se analiza todo el cuadro">
          <Maximize size={14} /> Usar cuadro completo</button>
        <button className="btn btn-navy" onClick={() => guardar(puntos)} disabled={guardando || puntos.length < 3}>
          <Save size={14} /> {guardando ? 'Guardando…' : 'Guardar área'}</button>
      </>}>
      <div className="pila" style={{ gap: 12 }}>
        <Aviso tipo="info">
          Haga <b>clic sobre el video</b> para marcar los vértices del área donde pasan los vehículos (por ejemplo, el carril de ingreso).
          Arrastre un vértice para ajustarlo y haga doble clic para quitarlo. Fuera del área no se buscan placas: se evitan lecturas de
          vehículos estacionados, de la vía pública o de rótulos.
        </Aviso>
        <ReproductorWebRTC etiqueta="ÁREA DE INTERÉS" capa={capa}
          obtener={async () => {
            const r = (await api.post(`/camaras/${camara.id}/video`)).data;
            return { whep: `${r.webrtc}/${r.ruta}/whep?ticket=${encodeURIComponent(r.ticket)}` };
          }} onFallo={m => setError(m)} />
        <div className="fila" style={{ justifyContent: 'space-between' }}>
          <span className="texto-secundario">
            {puntos.length === 0 ? 'Sin área: se analiza el cuadro completo.' : `${puntos.length} ${puntos.length === 1 ? 'vértice' : 'vértices'}${puntos.length < 3 ? ' (mínimo 3)' : ''}`}
          </span>
          <span className="fila" style={{ gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setPuntos(l => l.slice(0, -1))} disabled={!puntos.length}><Undo2 size={14} /> Deshacer</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setPuntos([])} disabled={!puntos.length}><Eraser size={14} /> Borrar todo</button>
          </span>
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
    </Modal>
  );
};
