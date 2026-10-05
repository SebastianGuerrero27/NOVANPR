import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Clock, Edit3, Plus, ShieldCheck, Undo2, X } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento } from '../../aplicacion/tiempoReal';
import { useConsulta, useDiferido } from '../../aplicacion/hooks';
import type { EstadoSolicitud, SolicitudAcceso } from '../../dominio/tipos';
import { CATEGORIAS_PERMISO, fecha, fechaHora, relativo } from '../../dominio/formato';
import { formatearPlaca } from '../../dominio/validacion';
import { Aviso, Confirmar, FilasEsqueleto, Placa, Segmentado, Tarjeta, Vacio } from '../componentes/ui';
import { AprobarSolicitud, FormularioSolicitud } from '../componentes/FormularioSolicitud';
import { useNotificar } from '../componentes/Notificaciones';

type Vista = 'pendiente' | 'resueltas' | 'todas';

const ESTADO: Record<EstadoSolicitud, { etiqueta: string; clase: string }> = {
  pendiente: { etiqueta: 'Pendiente', clase: 'pendiente_revision' },
  aprobada: { etiqueta: 'Aprobada', clase: 'autorizado' },
  rechazada: { etiqueta: 'Rechazada', clase: 'alerta' },
  cancelada: { etiqueta: 'Cancelada', clase: 'neutro' },
};

/**
 * Solicitudes de acceso. El personal ve las suyas y, mientras están pendientes, las edita o
 * cancela; el gestor de permisos (y quien tenga solicitudes:resolver) ve todas y las aprueba o
 * rechaza. Nadie resuelve las propias (separación de funciones, aplicada también por la API).
 */
const SolicitudesAcceso: React.FC<{ incrustada?: boolean; onVerPadron?: () => void }> = ({ incrustada, onVerPadron }) => {
  const { user, puede } = useAuth();
  const crea = puede('solicitudes:crear');
  const verIngresos = puede('operacion:monitorear');
  const notificar = useNotificar();
  const [params] = useSearchParams();
  const resuelve = puede('solicitudes:resolver');
  const [vista, setVista] = useState<Vista>('pendiente');
  const [nueva, setNueva] = useState(false);
  const [editando, setEditando] = useState<SolicitudAcceso | null>(null);
  const [aprobando, setAprobando] = useState<SolicitudAcceso | null>(null);
  const [rechazando, setRechazando] = useState<SolicitudAcceso | null>(null);
  const resaltada = Number(params.get('id')) || null;

  const { datos, cargando, error, recargar } = useConsulta<SolicitudAcceso[]>(
    () => api.get('/solicitudes-acceso', { params: { estado: vista } }).then(r => r.data), [vista]);
  const diferido = useDiferido(() => recargar(true), 600);
  useEvento('solicitudes:actualizadas', diferido);

  const cancelar = async (s: SolicitudAcceso) => {
    try {
      await api.post(`/solicitudes-acceso/${s.id}/cancelar`);
      notificar('exito', `Solicitud #${s.id} cancelada`);
      recargar(true);
    } catch (e) {
      notificar('error', 'No se pudo cancelar', mensajeError(e));
    }
  };

  return (
    <div className={incrustada ? undefined : 'pagina'}>
      <div className="pila">
        <Aviso tipo="info">
          {resuelve
            ? <>Revise cada solicitud y conceda un permiso con la vigencia y el horario adecuados. Por <b>separación de funciones</b>, no puede resolver las solicitudes que usted registró.</>
            : <>Sus solicitudes llegan al <b>gestor de permisos</b> como notificación. Recibirá otra notificación cuando sean resueltas.</>}
        </Aviso>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Tarjeta titulo={resuelve ? 'Solicitudes de acceso' : 'Mis solicitudes de acceso'}
          subtitulo="Ingreso de visitas, proveedores y vehículos sin permiso detectados en la garita"
          acciones={crea ? <button className="btn btn-navy btn-sm" onClick={() => setNueva(true)}><Plus size={14} /> Nueva solicitud</button> : undefined}
          sinPadding>
          <div className="filtros" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <Segmentado<Vista> valor={vista} onCambiar={setVista} opciones={[
              { valor: 'pendiente', etiqueta: 'Pendientes' }, { valor: 'resueltas', etiqueta: 'Resueltas' }, { valor: 'todas', etiqueta: 'Todas' },
            ]} />
          </div>
          {cargando && !datos ? <table className="tabla"><tbody><FilasEsqueleto columnas={3} filas={4} /></tbody></table> : (datos ?? []).map(s => {
            const propia = s.solicitante.id === user?.id;
            return (
              <div key={s.id} className="solicitud-tarjeta" style={resaltada === s.id ? { background: 'var(--pendiente-bg)' } : undefined}>
                <div className="pila" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <Placa valor={s.placa} />
                  <span className={`insignia ${ESTADO[s.estado].clase}`}>{ESTADO[s.estado].etiqueta}</span>
                </div>
                <div className="datos">
                  <strong style={{ color: 'var(--text)' }}>{s.propietario}
                    <span className="texto-secundario" style={{ fontWeight: 400 }}> · {CATEGORIAS_PERMISO[s.categoria] ?? s.categoria}{s.departamento ? ` · ${s.departamento}` : ''}</span></strong>
                  <span>{s.motivo}</span>
                  <span className="texto-secundario">
                    <Clock size={12} style={{ verticalAlign: -1 }} /> {s.fecha_inicio ? `desde ${fecha(s.fecha_inicio)} ` : ''}{s.fecha_fin ? `hasta ${fecha(s.fecha_fin)}` : 'sin vencimiento'} · {s.horario_texto}
                  </span>
                  <span className="texto-secundario">
                    Solicitada por {propia ? 'usted' : s.solicitante.nombre} {relativo(s.fecha_solicitud)}
                    {s.deteccion_id && <> · {verIngresos ? <Link to={`/detecciones/${s.deteccion_id}`}>ingreso #{s.deteccion_id}</Link> : `ingreso #${s.deteccion_id}`}</>}
                  </span>
                  {s.resolutor && (
                    <span className="texto-secundario">{ESTADO[s.estado].etiqueta} por {s.resolutor.nombre} · {fechaHora(s.fecha_resolucion)}{s.comentario_resolucion ? ` · “${s.comentario_resolucion}”` : ''}</span>
                  )}
                  {s.en_lista_alertas && <span style={{ color: 'var(--alerta)', fontWeight: 600 }}><AlertTriangle size={12} style={{ verticalAlign: -1 }} /> Placa en la lista negra</span>}
                </div>
                <div className="acciones">
                  {s.estado === 'pendiente' && resuelve && !propia && <>
                    <button className="btn btn-exito btn-sm" onClick={() => setAprobando(s)}><Check size={14} /> Aprobar</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setRechazando(s)}><X size={14} /> Rechazar</button>
                  </>}
                  {s.estado === 'pendiente' && propia && <>
                    {/* Editar exige solicitudes:crear, como la API (PUT); cancelar no */}
                    {crea && <button className="btn btn-ghost btn-sm" onClick={() => setEditando(s)}><Edit3 size={14} /> Editar</button>}
                    <button className="btn btn-ghost btn-sm" onClick={() => cancelar(s)}><Undo2 size={14} /> Cancelar</button>
                  </>}
                  {s.estado === 'aprobada' && s.vehiculo_autorizado_id && (onVerPadron
                    ? <button className="btn btn-ghost btn-sm" onClick={onVerPadron}><ShieldCheck size={14} /> Ver lista blanca</button>
                    : <Link className="btn btn-ghost btn-sm" to="/listas/autorizados"><ShieldCheck size={14} /> Ver lista blanca</Link>
                  )}
                </div>
              </div>
            );
          })}
          {datos && datos.length === 0 && (
            <Vacio titulo={vista === 'pendiente' ? 'No hay solicitudes pendientes' : 'Sin solicitudes'}
              texto={vista === 'pendiente' ? 'Las nuevas aparecerán aquí y en sus notificaciones.' : undefined} />
          )}
        </Tarjeta>
      </div>

      {nueva && <FormularioSolicitud onCerrar={() => setNueva(false)}
        onEnviada={s => { setNueva(false); notificar('exito', `Solicitud #${s.id} enviada`, 'El gestor de permisos fue notificado.'); recargar(true); }} />}
      {editando && <FormularioSolicitud solicitud={editando} onCerrar={() => setEditando(null)}
        onEnviada={s => { setEditando(null); notificar('exito', `Solicitud #${s.id} actualizada`, 'El gestor de permisos verá los datos actualizados.'); recargar(true); }} />}
      {aprobando && <AprobarSolicitud s={aprobando} onCerrar={() => setAprobando(null)}
        onAprobada={m => { setAprobando(null); notificar('exito', `Solicitud #${aprobando.id} aprobada`, m); recargar(true); }} />}
      {rechazando && (
        <Confirmar titulo={`Rechazar solicitud #${rechazando.id}`} pedirMotivo peligro textoBoton="Rechazar"
          mensaje={<>Se notificará a <b>{rechazando.solicitante.nombre}</b> que el ingreso de <b>{formatearPlaca(rechazando.placa)}</b> no fue autorizado.</>}
          onConfirmar={async motivo => {
            try { await api.post(`/solicitudes-acceso/${rechazando.id}/rechazar`, { comentario: motivo }); } catch (e) { throw new Error(mensajeError(e)); }
            notificar('exito', `Solicitud #${rechazando.id} rechazada`);
            recargar(true);
          }}
          onCerrar={() => setRechazando(null)} />
      )}
    </div>
  );
};

export default SolicitudesAcceso;
