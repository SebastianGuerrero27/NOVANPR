import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellRing, Bell, CheckCheck, CheckCircle2, ChevronRight, Loader2 } from 'lucide-react';
import { useCentroNotificaciones } from '../../aplicacion/notificaciones';
import { relativo } from '../../dominio/formato';
import type { Notificacion, Severidad } from '../../dominio/tipos';
import { useNotificar } from './Notificaciones';
import { mensajeError } from '../../infraestructura/api';

export const ETIQUETA_SEVERIDAD: Record<Severidad, string> = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Informativa' };

/** Estado del ciclo de vida de la alarma (ISA-18.2): pendiente → reconocida → resuelta. */
function estadoAlarma(n: Notificacion): { texto: string; clase: string } | null {
  if (n.resuelta) return { texto: 'Resuelta', clase: 'neutro' };
  if (n.atendida) return { texto: `Atendida${n.atendida.usuario ? ` por ${n.atendida.usuario.nombre}` : ''}`, clase: 'autorizado' };
  if (n.requiere_ack) return { texto: n.escalada ? 'Sin atender · escalada' : 'Pendiente de atención', clase: n.escalada ? 'alerta' : 'no_reconocido' };
  return null;
}

/** Fila de una notificación (campana y página). */
export const ItemNotificacion: React.FC<{ n: Notificacion; compacto?: boolean; onAbrir?: () => void }> = ({ n, compacto, onAbrir }) => {
  const { marcarLeida, reconocer } = useCentroNotificaciones();
  const navigate = useNavigate();
  const notificar = useNotificar();
  const [enviando, setEnviando] = useState(false);
  const estado = estadoAlarma(n);
  const puedeReconocer = n.requiere_ack && !n.atendida && !n.resuelta;

  const abrir = () => {
    if (!n.leida) void marcarLeida(n.id).catch(() => undefined);
    onAbrir?.();
    if (n.enlace) navigate(n.enlace);
  };
  const ack = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setEnviando(true);
    try { await reconocer(n.id); } catch (err) { notificar('error', 'No se pudo registrar la atención', mensajeError(err)); } finally { setEnviando(false); }
  };

  return (
    <div className={`notif-item sev-${n.severidad}${n.leida ? '' : ' no-leida'}${compacto ? ' compacto' : ''}`} role="button" tabIndex={0}
      onClick={abrir} onKeyDown={e => { if (e.key === 'Enter') abrir(); }}>
      <span className="notif-marca" aria-label={`Prioridad ${ETIQUETA_SEVERIDAD[n.severidad]}`} />
      <div className="notif-cuerpo">
        <div className="notif-titulo">
          <strong>{n.titulo}</strong>
          {n.repeticiones > 1 && <span className="notif-repeticiones" title="Repeticiones agrupadas">×{n.repeticiones}</span>}
        </div>
        <p className="notif-mensaje">{n.mensaje}</p>
        <div className="notif-pie">
          <span title={new Date(n.fecha_ultima).toLocaleString('es-EC')}>{relativo(n.fecha_ultima)}</span>
          {!compacto && <span className={`insignia ${n.severidad === 'critica' ? 'solido-alerta' : n.severidad === 'alta' ? 'alerta' : n.severidad === 'media' ? 'no_reconocido' : 'neutro'}`}>{ETIQUETA_SEVERIDAD[n.severidad]}</span>}
          {estado && <span className={`insignia ${estado.clase}`}>{estado.texto}</span>}
          {puedeReconocer && (
            <button className="btn btn-sm btn-secondary notif-ack" onClick={ack} disabled={enviando}>
              {enviando ? <Loader2 size={13} className="girar" /> : <CheckCircle2 size={13} />} Atendida
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/** Campana del encabezado: contador de no leídas y alarmas pendientes, y bandeja desplegable. */
export const CampanaNotificaciones: React.FC = () => {
  const { items, noLeidas, pendientes, marcarTodas } = useCentroNotificaciones();
  const navigate = useNavigate();
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', esc); };
  }, [abierto]);

  const Icono = pendientes > 0 ? BellRing : Bell;
  const etiqueta = `${noLeidas} sin leer${pendientes ? ` · ${pendientes} pendientes de atención` : ''}`;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={`btn btn-ghost btn-sm btn-icono campana${pendientes > 0 ? ' con-pendientes' : ''}`} onClick={() => setAbierto(a => !a)}
        aria-expanded={abierto} aria-haspopup="dialog" aria-label={`Notificaciones: ${etiqueta}`} title={`Notificaciones · ${etiqueta}`}>
        <Icono size={18} />
        {noLeidas > 0 && <span className={`campana-contador${pendientes > 0 ? ' urgente' : ''}`}>{noLeidas > 99 ? '99+' : noLeidas}</span>}
      </button>
      {abierto && (
        <div className="menu notif-panel" role="dialog" aria-label="Notificaciones">
          <div className="notif-panel-cabecera">
            <div><strong>Notificaciones</strong><span>{pendientes ? `${pendientes} pendientes de atención` : noLeidas ? `${noLeidas} sin leer` : 'Al día'}</span></div>
            {noLeidas > 0 && <button className="btn btn-ghost btn-sm" onClick={() => void marcarTodas()}><CheckCheck size={14} /> Marcar leídas</button>}
          </div>
          <div className="notif-panel-lista">
            {items.length === 0
              ? <div className="notif-vacio">No hay notificaciones.</div>
              : items.slice(0, 12).map(n => <ItemNotificacion key={n.id} n={n} compacto onAbrir={() => setAbierto(false)} />)}
          </div>
          <button className="notif-panel-pie" onClick={() => { setAbierto(false); navigate('/notificaciones'); }}>
            Ver todas y configurar <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
};
