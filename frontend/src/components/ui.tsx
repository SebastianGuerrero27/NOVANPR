import React, { useEffect, useId, useState } from 'react';
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, HelpCircle, Info, Inbox, Loader2,
  ShieldAlert, ShieldCheck, X,
} from 'lucide-react';
import type { EstadoValidacion } from '../lib/tipos';
import { ESTADOS, numero } from '../lib/formato';

/* ─── Contenedores ─── */

export const Tarjeta: React.FC<{
  titulo?: React.ReactNode; subtitulo?: React.ReactNode; acciones?: React.ReactNode;
  children: React.ReactNode; sinPadding?: boolean; className?: string; style?: React.CSSProperties;
}> = ({ titulo, subtitulo, acciones, children, sinPadding, className, style }) => (
  <section className={`tarjeta${className ? ' ' + className : ''}`} style={style}>
    {(titulo || acciones) && (
      <header className="tarjeta-cabecera">
        <div style={{ minWidth: 0 }}>
          {titulo && <h2>{titulo}</h2>}
          {subtitulo && <p>{subtitulo}</p>}
        </div>
        {acciones && <div className="acciones">{acciones}</div>}
      </header>
    )}
    <div className={`tarjeta-cuerpo${sinPadding ? ' sin-padding' : ''}`}>{children}</div>
  </section>
);

export const Kpi: React.FC<{
  etiqueta: string; valor: React.ReactNode; icono?: React.ReactNode; color?: string; fondo?: string;
  pie?: React.ReactNode; onClick?: () => void; cargando?: boolean;
}> = ({ etiqueta, valor, icono, color = 'var(--navy-800)', fondo = 'var(--surface-3)', pie, onClick, cargando }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="kpi" onClick={onClick} style={onClick ? { cursor: 'pointer', textAlign: 'left', font: 'inherit' } : undefined}>
      <div className="kpi-cabecera">
        <span className="kpi-etiqueta">{etiqueta}</span>
        {icono && <span className="kpi-icono" style={{ color, background: fondo }}>{icono}</span>}
      </div>
      {cargando ? <div className="esqueleto" style={{ height: 30, width: 70 }} /> : <div className="kpi-valor">{valor}</div>}
      {pie && <div className="kpi-pie">{pie}</div>}
    </Tag>
  );
};

/* ─── Estado de una detección ─── */

const ICONO_ESTADO: Record<EstadoValidacion, React.ReactNode> = {
  autorizado: <ShieldCheck size={13} />,
  alerta: <ShieldAlert size={13} />,
  no_reconocido: <HelpCircle size={13} />,
  pendiente_revision: <Clock size={13} />,
};

export const InsigniaEstado: React.FC<{ estado: EstadoValidacion; procesando?: boolean; corta?: boolean; solido?: boolean }> = ({ estado, procesando, corta, solido }) => {
  if (procesando) {
    return <span className="insignia neutro"><Loader2 size={12} className="girar" /> Leyendo placa…</span>;
  }
  const e = ESTADOS[estado] ?? ESTADOS.pendiente_revision;
  return <span className={`insignia ${estado}${solido ? ' solido' : ''}`}>{ICONO_ESTADO[estado]} {corta ? e.corta : e.etiqueta}</span>;
};

export const Placa: React.FC<{ valor?: string | null; grande?: boolean }> = ({ valor, grande }) =>
  valor
    ? <span className={`placa${grande ? ' grande' : ''}`}>{valor}</span>
    : <span className={`placa vacia${grande ? ' grande' : ''}`}>Sin lectura</span>;

/* ─── Avisos ─── */

const ICONO_AVISO = { info: Info, exito: CheckCircle2, advertencia: AlertTriangle, error: AlertCircle };

export const Aviso: React.FC<{ tipo?: keyof typeof ICONO_AVISO; children: React.ReactNode; style?: React.CSSProperties }> = ({ tipo = 'info', children, style }) => {
  const Icono = ICONO_AVISO[tipo];
  return <div className={`aviso ${tipo}`} role={tipo === 'error' ? 'alert' : undefined} style={style}><Icono size={16} /><div>{children}</div></div>;
};

export const Vacio: React.FC<{ titulo: string; texto?: React.ReactNode; icono?: React.ReactNode; accion?: React.ReactNode }> = ({ titulo, texto, icono, accion }) => (
  <div className="vacio">
    <div className="icono">{icono ?? <Inbox size={22} />}</div>
    <strong>{titulo}</strong>
    {texto && <p>{texto}</p>}
    {accion}
  </div>
);

export const Cargando: React.FC<{ texto?: string; alto?: number }> = ({ texto = 'Cargando…', alto = 160 }) => (
  <div style={{ minHeight: alto, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-3)', fontSize: 13 }}>
    <Loader2 size={18} className="girar" /> {texto}
  </div>
);

export const FilasEsqueleto: React.FC<{ filas?: number; columnas: number }> = ({ filas = 6, columnas }) => (
  <>
    {Array.from({ length: filas }, (_, i) => (
      <tr key={i}>{Array.from({ length: columnas }, (_, j) => <td key={j}><div className="esqueleto" style={{ height: 14, width: `${50 + ((i + j) % 4) * 12}%` }} /></td>)}</tr>
    ))}
  </>
);

/* ─── Paginación ─── */

export const Paginacion: React.FC<{ pagina: number; tamano: number; total: number; onCambiar: (p: number) => void }> = ({ pagina, tamano, total, onCambiar }) => {
  const paginas = Math.max(1, Math.ceil(total / tamano));
  const desde = total ? (pagina - 1) * tamano + 1 : 0;
  const hasta = Math.min(total, pagina * tamano);
  return (
    <div className="paginacion">
      <span>{total ? `${numero(desde)}–${numero(hasta)} de ${numero(total)}` : 'Sin resultados'}</span>
      <div className="fila">
        <button className="btn btn-secondary btn-sm" disabled={pagina <= 1} onClick={() => onCambiar(pagina - 1)}><ChevronLeft size={14} /> Anterior</button>
        <span>Página {pagina} de {paginas}</span>
        <button className="btn btn-secondary btn-sm" disabled={pagina >= paginas} onClick={() => onCambiar(pagina + 1)}>Siguiente <ChevronRight size={14} /></button>
      </div>
    </div>
  );
};

/* ─── Modal ─── */

export const Modal: React.FC<{
  titulo: React.ReactNode; subtitulo?: React.ReactNode; onCerrar: () => void; children: React.ReactNode;
  pie?: React.ReactNode; tamano?: 'estrecho' | 'normal' | 'ancho'; bloquear?: boolean;
}> = ({ titulo, subtitulo, onCerrar, children, pie, tamano = 'normal', bloquear }) => {
  const id = useId();
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape' && !bloquear) onCerrar(); };
    window.addEventListener('keydown', fn);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', fn); document.body.style.overflow = overflow; };
  }, [onCerrar, bloquear]);
  return (
    <div className="modal-fondo" onMouseDown={e => { if (e.target === e.currentTarget && !bloquear) onCerrar(); }}>
      <div className={`modal${tamano !== 'normal' ? ' ' + tamano : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="modal-cabecera">
          <div><h3 id={id}>{titulo}</h3>{subtitulo && <p>{subtitulo}</p>}</div>
          <button className="btn btn-ghost btn-sm btn-icono cerrar" onClick={onCerrar} disabled={bloquear} aria-label="Cerrar"><X size={16} /></button>
        </div>
        <div className="modal-cuerpo">{children}</div>
        {pie && <div className="modal-pie">{pie}</div>}
      </div>
    </div>
  );
};

/**
 * Confirmación de una acción. Con `pedirMotivo` exige un texto (mínimo 5 caracteres) que se
 * envía a la API y queda en la auditoría.
 */
export const Confirmar: React.FC<{
  titulo: string; mensaje: React.ReactNode; textoBoton?: string; peligro?: boolean; pedirMotivo?: boolean;
  onConfirmar: (motivo: string) => Promise<void> | void; onCerrar: () => void;
}> = ({ titulo, mensaje, textoBoton = 'Confirmar', peligro, pedirMotivo, onConfirmar, onCerrar }) => {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valido = !pedirMotivo || motivo.trim().length >= 5;
  const confirmar = async () => {
    setEnviando(true);
    setError(null);
    try {
      await onConfirmar(motivo.trim());
      onCerrar();
    } catch (e: any) {
      setError(e?.message || 'No se pudo completar la acción.');
      setEnviando(false);
    }
  };
  return (
    <Modal titulo={titulo} onCerrar={onCerrar} tamano="estrecho" bloquear={enviando}
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className={`btn ${peligro ? 'btn-primary' : 'btn-navy'}`} onClick={confirmar} disabled={!valido || enviando}>
          {enviando && <Loader2 size={14} className="girar" />} {textoBoton}
        </button>
      </>}>
      <div className="pila" style={{ gap: 14 }}>
        <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{mensaje}</div>
        {pedirMotivo && (
          <div className="campo">
            <label htmlFor="motivo-confirmar">Motivo (queda registrado en la auditoría)*</label>
            <textarea id="motivo-confirmar" className="textarea" value={motivo} onChange={e => setMotivo(e.target.value)} maxLength={300} autoFocus />
          </div>
        )}
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
    </Modal>
  );
};

/* ─── Controles ─── */

export function Segmentado<T extends string>({ opciones, valor, onCambiar }: {
  opciones: { valor: T; etiqueta: React.ReactNode }[]; valor: T; onCambiar: (v: T) => void;
}) {
  return (
    <div className="segmentado" role="tablist">
      {opciones.map(o => (
        <button key={o.valor} role="tab" aria-selected={o.valor === valor} className={o.valor === valor ? 'activo' : ''} onClick={() => onCambiar(o.valor)}>
          {o.etiqueta}
        </button>
      ))}
    </div>
  );
}

export function Pestanas<T extends string>({ opciones, valor, onCambiar }: {
  opciones: { valor: T; etiqueta: React.ReactNode; icono?: React.ReactNode; num?: number }[]; valor: T; onCambiar: (v: T) => void;
}) {
  return (
    <div className="pestanas" role="tablist">
      {opciones.map(o => (
        <button key={o.valor} role="tab" aria-selected={o.valor === valor} className={o.valor === valor ? 'activo' : ''} onClick={() => onCambiar(o.valor)}>
          {o.icono}{o.etiqueta}{o.num !== undefined && <span className="num">{numero(o.num)}</span>}
        </button>
      ))}
    </div>
  );
}

export const Interruptor: React.FC<{ activo: boolean; onCambiar: (v: boolean) => void; etiqueta: string; deshabilitado?: boolean }> = ({ activo, onCambiar, etiqueta, deshabilitado }) => (
  <label className="interruptor" title={etiqueta}>
    <input type="checkbox" checked={activo} onChange={e => onCambiar(e.target.checked)} disabled={deshabilitado} aria-label={etiqueta} />
    <span />
  </label>
);

/** Encabezado interno de página: título, descripción y acciones. */
export const EncabezadoPagina: React.FC<{ titulo: string; descripcion?: React.ReactNode; acciones?: React.ReactNode }> = ({ titulo, descripcion, acciones }) => (
  <div className="fila" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16, gap: 12 }}>
    <div style={{ minWidth: 0 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.3 }}>{titulo}</h2>
      {descripcion && <p className="texto-secundario" style={{ fontSize: 13, marginTop: 2 }}>{descripcion}</p>}
    </div>
    {acciones && <div className="fila">{acciones}</div>}
  </div>
);
