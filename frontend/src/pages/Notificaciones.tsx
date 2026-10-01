import React, { useEffect, useMemo, useState } from 'react';
import { BellOff, BellRing, CheckCheck, Loader2, Send, Smartphone } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import type { Permiso } from '../lib/permisos';
import { useCentroNotificaciones } from '../lib/notificaciones';
import { activarPush, desactivarPush, estadoPush, EstadoPush } from '../lib/push';
import { useConsulta } from '../lib/hooks';
import type { Notificacion, Severidad } from '../lib/tipos';
import { Aviso, Segmentado, Tarjeta, Vacio } from '../components/ui';
import { ETIQUETA_SEVERIDAD, ItemNotificacion } from '../components/CentroNotificaciones';
import { useNotificar } from '../components/Notificaciones';

type Filtro = 'todas' | 'no_leidas' | 'pendientes';

const pendiente = (n: Notificacion) => n.requiere_ack && !n.atendida && !n.resuelta;

const TEXTO_ESTADO: Record<EstadoPush, string> = {
  no_soportado: 'Este navegador no admite notificaciones push.',
  inseguro: 'Las notificaciones push requieren una conexión segura (https) o abrir el sistema en http://localhost.',
  deshabilitado: 'El administrador desactivó las notificaciones push en el servidor.',
  denegado: 'El navegador bloqueó las notificaciones de este sitio. Habilítelas en la configuración del navegador (icono del candado).',
  activo: 'Este equipo recibe las alarmas críticas y altas aunque la pestaña esté cerrada o en segundo plano.',
  inactivo: 'Actívelas para recibir las alarmas aunque la pestaña esté cerrada o minimizada.',
};

/** Configuración del canal push de este equipo. */
const CanalNavegador: React.FC = () => {
  const notificar = useNotificar();
  const [estado, setEstado] = useState<EstadoPush | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { estadoPush().then(setEstado).catch(() => setEstado('no_soportado')); }, []);

  const ejecutar = async (accion: () => Promise<EstadoPush | void>, exito?: string) => {
    setOcupado(true);
    try {
      const r = await accion();
      if (r) setEstado(r);
      if (exito) notificar('exito', exito);
    } catch (e) {
      notificar('error', 'Notificaciones del navegador', mensajeError(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Tarjeta titulo="Notificaciones del navegador" subtitulo="Web Push con claves VAPID (estándar W3C · RFC 8030)">
      <div className="pila" style={{ gap: 12 }}>
        <div className="fila" style={{ gap: 10 }}>
          <span className={`punto ${estado === 'activo' ? 'verde' : estado === 'inactivo' ? 'ambar' : 'rojo'}`} />
          <strong>{estado === null ? 'Comprobando…' : estado === 'activo' ? 'Activas en este equipo' : 'Inactivas en este equipo'}</strong>
        </div>
        {estado && <p className="texto-secundario">{TEXTO_ESTADO[estado]}</p>}
        <div className="fila">
          {estado === 'inactivo' && (
            <button className="btn btn-navy btn-sm" disabled={ocupado} onClick={() => ejecutar(activarPush, 'Notificaciones activadas en este equipo')}>
              {ocupado ? <Loader2 size={14} className="girar" /> : <BellRing size={14} />} Activar
            </button>
          )}
          {estado === 'activo' && <>
            <button className="btn btn-secondary btn-sm" disabled={ocupado}
              onClick={() => ejecutar(async () => { const r = await api.post('/notificaciones/push/prueba'); notificar('exito', r.data.message); })}>
              <Send size={14} /> Enviar prueba
            </button>
            <button className="btn btn-ghost btn-sm" disabled={ocupado} onClick={() => ejecutar(desactivarPush, 'Notificaciones desactivadas en este equipo')}>
              <BellOff size={14} /> Desactivar
            </button>
          </>}
        </div>
        <Aviso tipo="info">
          <Smartphone size={13} style={{ verticalAlign: -2 }} /> En el puesto de guardia, deje la sesión abierta: al cerrar sesión el equipo deja de recibir los avisos de su cuenta.
        </Aviso>
      </div>
    </Tarjeta>
  );
};

interface TipoCatalogo { tipo: string; etiqueta: string; severidad: Severidad; requiere_ack: boolean; push: boolean; permiso: Permiso | null }

/** Qué avisos recibe la cuenta según los permisos de su rol. */
const AvisosQueRecibe: React.FC = () => {
  const { puede } = useAuth();
  const { datos } = useConsulta<TipoCatalogo[]>(() => api.get('/notificaciones/catalogo').then(r => r.data), []);
  const propios = (datos ?? []).filter(t => t.permiso && puede(t.permiso));
  return (
    <Tarjeta titulo="Avisos que recibe su rol" subtitulo="El enrutamiento sigue los permisos del rol (RBAC)" sinPadding>
      <ul className="lista-simple">
        {propios.map(t => (
          <li key={t.tipo}>
            <span className={`notif-marca-estatica sev-${t.severidad}`} />
            <span style={{ flex: 1 }}>{t.etiqueta}</span>
            <span className="texto-secundario" style={{ fontSize: 11.5 }}>{ETIQUETA_SEVERIDAD[t.severidad]}{t.requiere_ack ? ' · requiere atención' : ''}{t.push ? ' · push' : ''}</span>
          </li>
        ))}
        <li><span className="notif-marca-estatica sev-baja" /><span style={{ flex: 1 }}>Resultado de sus solicitudes de acceso</span><span className="texto-secundario" style={{ fontSize: 11.5 }}>Informativa · push</span></li>
      </ul>
    </Tarjeta>
  );
};

const Notificaciones: React.FC = () => {
  const { items, noLeidas, pendientes, hayMas, cargando, cargarMas, marcarTodas } = useCentroNotificaciones();
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [cargandoMas, setCargandoMas] = useState(false);
  const filas = useMemo(() => items.filter(n => filtro === 'todas' || (filtro === 'no_leidas' ? !n.leida : pendiente(n))), [items, filtro]);

  return (
    <div className="pagina">
      <div className="grid-principal">
        <Tarjeta titulo="Bandeja" subtitulo="Alarmas y avisos del sistema; las que requieren atención se escalan si nadie las reconoce."
          acciones={noLeidas > 0 ? <button className="btn btn-secondary btn-sm" onClick={() => void marcarTodas()}><CheckCheck size={14} /> Marcar todas leídas</button> : undefined}
          sinPadding>
          <div className="filtros" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <Segmentado<Filtro> valor={filtro} onCambiar={setFiltro} opciones={[
              { valor: 'todas', etiqueta: 'Todas' },
              { valor: 'no_leidas', etiqueta: `Sin leer (${noLeidas})` },
              { valor: 'pendientes', etiqueta: `Pendientes de atención (${pendientes})` },
            ]} />
          </div>
          <div className="notif-pagina-lista">
            {filas.map(n => <ItemNotificacion key={n.id} n={n} />)}
          </div>
          {!cargando && filas.length === 0 && (
            <Vacio titulo={filtro === 'pendientes' ? 'Sin alarmas pendientes' : 'Sin notificaciones'} texto="Las nuevas aparecerán aquí en tiempo real." />
          )}
          {hayMas && filtro === 'todas' && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button className="btn btn-secondary btn-sm" disabled={cargandoMas}
                onClick={async () => { setCargandoMas(true); try { await cargarMas(); } finally { setCargandoMas(false); } }}>
                {cargandoMas && <Loader2 size={14} className="girar" />} Cargar anteriores
              </button>
            </div>
          )}
        </Tarjeta>
        <div className="pila">
          <CanalNavegador />
          <AvisosQueRecibe />
        </div>
      </div>
    </div>
  );
};

export default Notificaciones;
