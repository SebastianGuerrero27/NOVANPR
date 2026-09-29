import React, { useLayoutEffect, useRef, useState } from 'react';
import { numero } from '../lib/formato';

/**
 * Gráficos SVG livianos (sin librerías). Reglas: una sola escala por gráfico, series en
 * orden fijo con leyenda siempre visible, separación de 2 px entre segmentos, extremos de
 * dato redondeados y tooltip al pasar el cursor.
 */

export interface Serie { clave: string; etiqueta: string; color: string }

function useAncho<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [ancho, setAncho] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(e => setAncho(Math.floor(e[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, ancho];
}

/** Máximo "redondo" para el eje (1, 2, 5 × 10ⁿ) y sus marcas. */
function escala(max: number, marcas = 4): number[] {
  if (max <= 0) return [0, 1];
  const paso0 = max / marcas;
  const mag = Math.pow(10, Math.floor(Math.log10(paso0)));
  const paso = [1, 2, 5, 10].map(m => m * mag).find(p => p >= paso0) ?? 10 * mag;
  const pasoFinal = Math.max(1, paso);
  const n = Math.ceil(max / pasoFinal);
  return Array.from({ length: n + 1 }, (_, i) => i * pasoFinal);
}

export const Leyenda: React.FC<{ series: readonly Serie[] }> = ({ series }) => (
  <div className="leyenda">
    {series.map(s => <span key={s.clave}><i style={{ background: s.color }} />{s.etiqueta}</span>)}
  </div>
);

interface Tip { x: number; y: number; titulo: string; filas: { etiqueta: string; color: string; valor: number }[]; total: number }

const Tooltip: React.FC<{ tip: Tip | null }> = ({ tip }) => {
  if (!tip) return null;
  const izquierda = Math.min(tip.x + 14, window.innerWidth - 200);
  return (
    <div className="tooltip-grafico" style={{ left: izquierda, top: tip.y + 14 }}>
      <strong>{tip.titulo}</strong>
      {tip.filas.map(f => (
        <div className="fila-tt" key={f.etiqueta}><span><i style={{ background: f.color }} /> {f.etiqueta}</span><b>{numero(f.valor)}</b></div>
      ))}
      <div className="fila-tt" style={{ borderTop: '1px solid rgba(255,255,255,0.15)', marginTop: 4, paddingTop: 4 }}><span>Total</span><b>{numero(tip.total)}</b></div>
    </div>
  );
};

/** Trayectoria de un rectángulo con las esquinas superiores redondeadas. */
function rectSuperiorRedondeado(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export const BarrasApiladas: React.FC<{
  datos: Record<string, any>[];
  series: readonly Serie[];
  etiquetaX: (d: Record<string, any>, i: number) => string;
  tituloTip?: (d: Record<string, any>, i: number) => string;
  alto?: number;
  cadaEtiqueta?: number;
  resaltar?: number;
}> = ({ datos, series, etiquetaX, tituloTip, alto = 220, cadaEtiqueta = 1, resaltar }) => {
  const [ref, ancho] = useAncho<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const margen = { izq: 34, der: 6, sup: 8, inf: 24 };
  const totales = datos.map(d => series.reduce((s, x) => s + Number(d[x.clave] || 0), 0));
  const marcas = escala(Math.max(...totales, 0));
  const maxEje = marcas[marcas.length - 1] || 1;
  const w = Math.max(0, ancho - margen.izq - margen.der);
  const h = alto - margen.sup - margen.inf;
  const banda = datos.length ? w / datos.length : 0;
  const anchoBarra = Math.max(2, Math.min(36, banda * 0.66));
  const y = (v: number) => margen.sup + h - (v / maxEje) * h;

  return (
    <div ref={ref} style={{ width: '100%' }} onMouseLeave={() => { setTip(null); setHover(null); }}>
      {ancho > 0 && (
        <svg className="grafico" width={ancho} height={alto} role="img" aria-label="Gráfico de barras por estado">
          {marcas.map(m => (
            <g key={m}>
              <line className="rejilla" x1={margen.izq} x2={ancho - margen.der} y1={y(m)} y2={y(m)} />
              <text x={margen.izq - 6} y={y(m) + 4} textAnchor="end">{numero(m)}</text>
            </g>
          ))}
          {datos.map((d, i) => {
            const x0 = margen.izq + i * banda + (banda - anchoBarra) / 2;
            let acumulado = 0;
            const visibles = series.filter(s => Number(d[s.clave] || 0) > 0);
            return (
              <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                {resaltar === i && <rect x={margen.izq + i * banda} y={margen.sup} width={banda} height={h} fill="#f1f5f9" />}
                {visibles.map((s, j) => {
                  const v = Number(d[s.clave]);
                  const yTop = y(acumulado + v);
                  const alturaSeg = y(acumulado) - yTop;
                  acumulado += v;
                  const esUltimo = j === visibles.length - 1;
                  // 2 px de separación entre segmentos apilados
                  const alt = Math.max(0, alturaSeg - (esUltimo ? 0 : 2));
                  return esUltimo
                    ? <path key={s.clave} d={rectSuperiorRedondeado(x0, yTop, anchoBarra, alt, 4)} fill={s.color} />
                    : <rect key={s.clave} x={x0} y={yTop + 2} width={anchoBarra} height={alt} fill={s.color} />;
                })}
                {/* Zona de interacción más grande que la barra */}
                <rect x={margen.izq + i * banda} y={margen.sup} width={banda} height={h} fill="transparent"
                  onMouseMove={e => {
                    setHover(i);
                    setTip({
                      x: e.clientX, y: e.clientY, titulo: (tituloTip ?? etiquetaX)(d, i), total: totales[i],
                      filas: series.map(s => ({ etiqueta: s.etiqueta, color: s.color, valor: Number(d[s.clave] || 0) })),
                    });
                  }} />
                {i % cadaEtiqueta === 0 && (
                  <text x={margen.izq + i * banda + banda / 2} y={alto - 6} textAnchor="middle">{etiquetaX(d, i)}</text>
                )}
              </g>
            );
          })}
          <line className="eje" x1={margen.izq} x2={ancho - margen.der} y1={y(0)} y2={y(0)} />
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
};

/** Barras horizontales (ranking por categoría), opcionalmente apiladas por estado. */
export const BarrasHorizontales: React.FC<{
  filas: { etiqueta: string; valores: Record<string, number>; total: number }[];
  series: readonly Serie[];
}> = ({ filas, series }) => {
  const max = Math.max(1, ...filas.map(f => f.total));
  const [tip, setTip] = useState<Tip | null>(null);
  return (
    <div className="pila" style={{ gap: 10 }} onMouseLeave={() => setTip(null)}>
      {filas.map(f => (
        <div className="barra-h" key={f.etiqueta}
          onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, titulo: f.etiqueta, total: f.total,
            filas: series.map(s => ({ etiqueta: s.etiqueta, color: s.color, valor: f.valores[s.clave] || 0 })) })}>
          <span className="truncar" title={f.etiqueta}>{f.etiqueta}</span>
          <div className="pista">
            {series.map(s => {
              const v = f.valores[s.clave] || 0;
              return v > 0 ? <div key={s.clave} style={{ width: `${(v / max) * 100}%`, background: s.color }} /> : null;
            })}
          </div>
          <span className="valor">{numero(f.total)}</span>
        </div>
      ))}
      <Tooltip tip={tip} />
    </div>
  );
};

/** Distribución de un total en una barra única segmentada (con leyenda y porcentajes). */
export const BarraDistribucion: React.FC<{ valores: Record<string, number>; series: readonly Serie[] }> = ({ valores, series }) => {
  const total = series.reduce((s, x) => s + (valores[x.clave] || 0), 0);
  return (
    <div className="pila" style={{ gap: 10 }}>
      <div style={{ display: 'flex', gap: 2, height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--surface-3)' }}>
        {total > 0 && series.map(s => (valores[s.clave] || 0) > 0 && (
          <div key={s.clave} style={{ width: `${(valores[s.clave] / total) * 100}%`, background: s.color }} title={`${s.etiqueta}: ${valores[s.clave]}`} />
        ))}
      </div>
      <div className="leyenda">
        {series.map(s => (
          <span key={s.clave}><i style={{ background: s.color }} />{s.etiqueta} <b style={{ color: 'var(--text)' }}>{numero(valores[s.clave] || 0)}</b>
            {total > 0 && <span className="texto-secundario">({Math.round(((valores[s.clave] || 0) / total) * 100)} %)</span>}</span>
        ))}
      </div>
    </div>
  );
};
