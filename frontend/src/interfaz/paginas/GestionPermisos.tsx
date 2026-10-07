import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock, Clock, FileCheck2, Plus, Repeat, ShieldCheck, ShieldOff, ShieldX } from 'lucide-react';
import api from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento } from '../../aplicacion/tiempoReal';
import { useConsulta, useDiferido } from '../../aplicacion/hooks';
import type { PanelAccesos as Panel } from '../../dominio/tipos';
import { fechaHora, numero, relativo } from '../../dominio/formato';
import { formatearPlaca } from '../../dominio/validacion';
import { Aviso, Kpi, Pestanas, Placa, Tarjeta, Vacio } from '../componentes/ui';
import { FormularioLista } from '../componentes/FormularioLista';
import { useNotificar } from '../componentes/Notificaciones';
import SolicitudesAcceso from './SolicitudesAcceso';
import Listas from './Listas';

type Pestana = 'solicitudes' | 'permisos' | 'sin_permiso';

const RESTRICCION: Record<string, string> = { fuera_horario: 'Fuera de horario', no_iniciada: 'Permiso aún no vigente', vencida: 'Permiso vencido' };

/**
 * Vista única del gestor de permisos: todo lo necesario para conceder permisos de placa en una
 * sola pantalla, sin monitoreo en vivo ni registro de ingresos. Pestañas: solicitudes por
 * resolver, padrón de permisos y placas sin permiso (reincidentes y accesos denegados).
 *
 * La pestaña vive en la URL (?pestana=), igual que los enlaces de las notificaciones
 * (?id= de una solicitud, ?q= de la lista blanca filtrada por placa), que llegan aquí redirigidos.
 */
const GestionPermisos: React.FC = () => {
  const { user } = useAuth();
  const notificar = useNotificar();
  const [params, setParams] = useSearchParams();
  const [concediendo, setConcediendo] = useState<string | null>(null);
  const placaResaltada = params.get('placa');
  const pestanaUrl = params.get('pestana');
  const pestana: Pestana = pestanaUrl === 'permisos' || pestanaUrl === 'sin_permiso' || pestanaUrl === 'solicitudes'
    ? pestanaUrl : params.get('q') ? 'permisos' : placaResaltada ? 'sin_permiso' : 'solicitudes';

  const { datos: p, cargando, error, recargar } = useConsulta<Panel>(() => api.get('/panel/accesos').then(r => r.data), []);
  const diferido = useDiferido(() => recargar(true), 3000);
  useEvento('solicitudes:actualizadas', diferido);
  useEvento('listas:actualizadas', diferido);
  useEvento('deteccion:actualizada', diferido);

  const cambiar = (destino: Pestana, extra: Record<string, string> = {}) => setParams({ pestana: destino, ...extra });

  return (
    <div className="pagina">
      <div className="fila" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 21, fontWeight: 800 }}>Gestión de permisos · {user?.nombre.split(' ')[0]}</h2>
          <p className="texto-secundario">Registre vehículos en la lista blanca y resuelva las solicitudes de acceso · {p ? `actualizado ${relativo(p.generado)}` : 'cargando…'}</p>
        </div>
        <button className="btn btn-navy" onClick={() => setConcediendo('')}><Plus size={16} /> Agregar a lista blanca</button>
      </div>
      {error && <Aviso tipo="error" style={{ marginBottom: 16 }}>{error}</Aviso>}

      <div className="pila">
        <div className="grid-kpi">
          <Kpi etiqueta="Solicitudes pendientes" valor={numero(p?.solicitudes.pendientes)} icono={<FileCheck2 size={17} />} cargando={cargando}
            color="var(--pendiente)" fondo="var(--pendiente-bg)" onClick={() => cambiar('solicitudes')}
            pie={p?.solicitudes.ultimas[0] ? `La más antigua: ${relativo(p.solicitudes.ultimas[0].fecha_solicitud)}` : 'Al día'} />
          <Kpi etiqueta="Vigentes en lista blanca" valor={numero(p?.padron.vigentes)} icono={<ShieldCheck size={17} />} cargando={cargando}
            color="var(--autorizado)" fondo="var(--autorizado-bg)" onClick={() => cambiar('permisos')}
            pie={p ? `${numero(p.padron.con_horario)} con horario · ${numero(p.padron.por_iniciar)} por iniciar` : undefined} />
          <Kpi etiqueta={`Vencen en ${p?.padron.dias_aviso ?? 7} días`} valor={numero(p?.padron.por_vencer)} icono={<CalendarClock size={17} />} cargando={cargando}
            color="var(--no-registrado)" fondo="var(--no-registrado-bg)" onClick={() => cambiar('permisos', { vigencia: 'por_vencer' })}
            pie={p ? `${numero(p.padron.vencidos)} vencidos sin retirar` : undefined} />
          <Kpi etiqueta="Accesos denegados hoy" valor={numero(p ? p.hoy.sin_permiso + p.hoy.restringidos : undefined)} icono={<ShieldX size={17} />} cargando={cargando}
            color="var(--alerta)" fondo="var(--alerta-bg)" onClick={() => cambiar('sin_permiso')}
            pie={p ? `${numero(p.hoy.sin_permiso)} sin permiso · ${numero(p.hoy.restringidos)} fuera de horario/vigencia` : undefined} />
        </div>

        <Pestanas<Pestana> valor={pestana} onCambiar={v => cambiar(v)} opciones={[
          { valor: 'solicitudes', etiqueta: 'Solicitudes', icono: <FileCheck2 size={15} />, num: p?.solicitudes.pendientes },
          { valor: 'permisos', etiqueta: 'Lista blanca', icono: <ShieldCheck size={15} />, num: p?.padron.vigentes },
          { valor: 'sin_permiso', etiqueta: 'Placas sin permiso', icono: <ShieldX size={15} />, num: p?.reincidentes.length },
        ]} />

        {pestana === 'solicitudes' && <SolicitudesAcceso incrustada onVerPadron={() => cambiar('permisos')} />}

        {/* La clave reinicia los filtros de la lista cuando cambian en la URL (vigencia, búsqueda) */}
        {pestana === 'permisos' && <Listas key={params.toString()} tipo="autorizados" incrustada />}

        {pestana === 'sin_permiso' && p && (
          <div className="grid-principal">
            <Tarjeta titulo="Placas reincidentes sin permiso" subtitulo="Últimos 7 días · ¿conceder el permiso?" sinPadding>
              {p.reincidentes.length === 0 ? <Vacio titulo="Sin reincidencias" icono={<Repeat size={20} />} /> : (
                <div className="tabla-contenedor"><table className="tabla"><tbody>
                  {p.reincidentes.map(r => (
                    <tr key={r.placa} style={r.placa === placaResaltada ? { background: 'var(--pendiente-bg)' } : undefined}>
                      <td><Placa valor={r.placa} /></td>
                      <td className="num"><b>{numero(r.intentos)}</b> <span className="texto-secundario">intentos</span></td>
                      <td className="ocultar-movil texto-secundario">{relativo(r.ultimo)}</td>
                      <td className="acciones-celda">
                        <button className="btn btn-secondary btn-sm" onClick={() => setConcediendo(r.placa)}><Plus size={13} /> Agregar a lista blanca</button>
                      </td>
                    </tr>
                  ))}
                </tbody></table></div>
              )}
            </Tarjeta>

            <Tarjeta titulo="Accesos denegados recientes" subtitulo="Sin permiso o fuera del horario/vigencia del permiso" sinPadding>
              {p.denegados_recientes.length === 0 ? <Vacio titulo="Sin accesos denegados en la semana" icono={<ShieldOff size={20} />} /> : (
                <div className="tabla-contenedor"><table className="tabla"><tbody>
                  {p.denegados_recientes.map(d => (
                    <tr key={d.id}>
                      <td><Placa valor={d.placa} /></td>
                      <td>{d.restriccion_acceso
                        ? <span className="insignia no_reconocido"><Clock size={12} /> {RESTRICCION[d.restriccion_acceso]}</span>
                        : <span className="insignia alerta">Sin permiso</span>}
                        {d.autorizado && <span className="secundario">{d.autorizado.propietario}</span>}</td>
                      <td className="ocultar-movil"><span className="texto-secundario">{fechaHora(d.fecha_hora_ingreso)}</span><span className="secundario">{d.camara?.nombre ?? '—'}</span></td>
                      <td className="acciones-celda">
                        {d.restriccion_acceso
                          ? <button className="btn btn-ghost btn-sm" onClick={() => cambiar('permisos', { q: d.placa ?? '' })}><ShieldCheck size={13} /> Revisar permiso</button>
                          : <button className="btn btn-secondary btn-sm" onClick={() => setConcediendo(d.placa ?? '')}><Plus size={13} /> Agregar a lista blanca</button>}
                      </td>
                    </tr>
                  ))}
                </tbody></table></div>
              )}
            </Tarjeta>
          </div>
        )}
      </div>

      {concediendo !== null && (
        <FormularioLista tipo="autorizados" inicial={concediendo ? { placa: concediendo } : undefined} onCerrar={() => setConcediendo(null)}
          onGuardado={r => { setConcediendo(null); notificar('exito', `Permiso concedido a ${formatearPlaca(r.placa)}`); recargar(true); }} />
      )}
    </div>
  );
};

export default GestionPermisos;
