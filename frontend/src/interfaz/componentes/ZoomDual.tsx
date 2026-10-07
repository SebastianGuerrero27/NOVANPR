import React, { useEffect, useRef, useState } from 'react';
import { Calendar, Camera, Car, Move, RotateCcw, ScanLine, User, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { Deteccion } from '../../dominio/tipos';
import { fechaHora, porcentaje } from '../../dominio/formato';
import { urlMedia } from '../../infraestructura/api';
import { InsigniaEstado, Placa } from './ui';

/**
 * Visor de evidencia con zoom (vehículo y placa lado a lado).
 * Rueda del ratón = zoom hacia el cursor · arrastrar = desplazar · doble clic = 2,5× / 1× ·
 * botones +, − y restablecer. Hasta 6× para leer la placa en detalle.
 */

const MAX = 6;
const PASO = 0.3;

const PanelZoom: React.FC<{ titulo: string; icono: React.ReactNode; ruta: string | null; alt: string }> = ({ titulo, icono, ruta, alt }) => {
  const [escala, setEscala] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [arrastre, setArrastre] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState(false);
  const caja = useRef<HTMLDivElement>(null);
  const estado = useRef({ escala: 1, pos: { x: 0, y: 0 } });
  estado.current = { escala, pos };
  const src = urlMedia(ruta);

  const aplicar = (nueva: number, cx?: number, cy?: number) => {
    const s = estado.current.escala;
    const e = Math.min(MAX, Math.max(1, +nueva.toFixed(2)));
    if (e === 1) { setEscala(1); setPos({ x: 0, y: 0 }); return; }
    // Mantiene fijo el punto bajo el cursor (coordenadas relativas al centro del panel)
    const px = cx ?? 0;
    const py = cy ?? 0;
    const p = estado.current.pos;
    setPos({ x: px - ((px - p.x) / s) * e, y: py - ((py - p.y) / s) * e });
    setEscala(e);
  };

  const relativo = (clientX: number, clientY: number) => {
    const r = caja.current!.getBoundingClientRect();
    return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
  };

  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    const rueda = (ev: WheelEvent) => {
      ev.preventDefault();
      const c = relativo(ev.clientX, ev.clientY);
      aplicar(estado.current.escala * (ev.deltaY < 0 ? 1.18 : 1 / 1.18), c.x, c.y);
    };
    el.addEventListener('wheel', rueda, { passive: false });
    return () => el.removeEventListener('wheel', rueda);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, error]);

  const boton = (onClick: () => void, deshabilitado: boolean, titulo: string, icono: React.ReactNode) => (
    <button onClick={onClick} disabled={deshabilitado} title={titulo} aria-label={titulo} className="zoom-boton">{icono}</button>
  );

  return (
    <section className="zoom-panel">
      <header className="zoom-panel-cabecera">
        <span className="fila" style={{ gap: 8 }}>{icono}<strong>{titulo}</strong></span>
        <span className="fila" style={{ gap: 4 }}>
          <span className="zoom-porcentaje" style={{ color: escala > 1 ? '#7dd3fc' : '#94a3b8' }}>{Math.round(escala * 100)} %</span>
          {boton(() => aplicar(escala - PASO), escala <= 1, 'Reducir', <ZoomOut size={14} />)}
          {boton(() => aplicar(1), escala === 1, 'Restablecer', <RotateCcw size={14} />)}
          {boton(() => aplicar(escala + PASO), escala >= MAX, 'Ampliar', <ZoomIn size={14} />)}
        </span>
      </header>
      <div ref={caja} className="zoom-lienzo"
        style={{ cursor: !src || error ? 'default' : escala > 1 ? (arrastre ? 'grabbing' : 'grab') : 'zoom-in' }}
        onPointerDown={e => { if (escala > 1) { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setArrastre({ x: e.clientX - pos.x, y: e.clientY - pos.y }); } }}
        onPointerMove={e => { if (arrastre) setPos({ x: e.clientX - arrastre.x, y: e.clientY - arrastre.y }); }}
        onPointerUp={() => setArrastre(null)}
        onPointerCancel={() => setArrastre(null)}
        onDoubleClick={e => { if (escala > 1) aplicar(1); else { const c = relativo(e.clientX, e.clientY); aplicar(2.5, c.x, c.y); } }}>
        {src && !error ? (
          <img src={src} alt={alt} draggable={false} onError={() => setError(true)}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${escala})`,
              transition: arrastre ? 'none' : 'transform 0.08s ease-out',
            }} />
        ) : <span className="texto-secundario">Imagen no disponible</span>}
      </div>
      <footer className="zoom-ayuda"><Move size={11} /> Rueda del ratón para zoom · arrastre para explorar · doble clic para ampliar</footer>
    </section>
  );
};

export const VisorZoom: React.FC<{ d: Deteccion; onCerrar: () => void }> = ({ d, onCerrar }) => {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCerrar(); } };
    window.addEventListener('keydown', fn, true);
    return () => window.removeEventListener('keydown', fn, true);
  }, [onCerrar]);

  return (
    <div className="zoom-fondo" onMouseDown={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="zoom-modal" role="dialog" aria-modal="true" aria-label={`Evidencia de ${d.placa ?? 'ingreso sin lectura'}`}>
        <header className="zoom-cabecera">
          <div className="fila" style={{ gap: 12 }}>
            <Placa valor={d.placa} grande />
            <InsigniaEstado estado={d.estado_validacion} procesando={d.estado_procesamiento === 'pendiente_ocr'} />
            {d.confianza_ocr !== null && <span className="zoom-dato"><ScanLine size={13} /> Confianza OCR <b>{porcentaje(d.confianza_ocr)}</b></span>}
          </div>
          <button className="zoom-cerrar" onClick={onCerrar}><X size={16} /> Cerrar (Esc)</button>
        </header>
        <div className="zoom-metadatos">
          <span><Calendar size={13} /> {fechaHora(d.fecha_hora_ingreso)}</span>
          {d.camara && <span><Camera size={13} /> {d.camara.nombre} · {d.camara.ubicacion}</span>}
          {d.autorizado && <span><User size={13} /> {d.autorizado.propietario}{d.autorizado.departamento ? ` · ${d.autorizado.departamento}` : ''}</span>}
          {d.alerta && <span style={{ color: '#fca5a5' }}>{d.alerta.motivo}</span>}
          {(d.vehiculo.marca || d.vehiculo.color || d.tipo_vehiculo) && (
            <span><Car size={13} /> {[d.tipo_vehiculo, [d.vehiculo.marca, d.vehiculo.modelo].filter(Boolean).join(' '), d.vehiculo.color].filter(Boolean).join(' · ')}</span>
          )}
        </div>
        <div className="zoom-paneles">
          <PanelZoom titulo="Captura del vehículo" icono={<Camera size={15} color="#7dd3fc" />} ruta={d.imagen_vehiculo} alt={`Vehículo ${d.placa ?? ''}`} />
          <PanelZoom titulo="Recorte de la placa" icono={<ScanLine size={15} color="#7dd3fc" />} ruta={d.imagen_placa} alt={`Placa ${d.placa ?? ''}`} />
        </div>
      </div>
    </div>
  );
};
