import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarClock, Clock, FileCheck2, Plus, Repeat, ShieldCheck, ShieldOff, ShieldX } from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta, useDiferido } from '../lib/hooks';
import type { PanelAccesos as Panel } from '../lib/tipos';
import { CATEGORIAS_PERMISO, fechaHora, hora, numero, relativo } from '../lib/formato';
import { Aviso, Kpi, Placa, Tarjeta, Vacio } from '../components/ui';
import { FormularioLista } from '../components/FormularioLista';
import { useNotificar } from '../components/Notificaciones';

const RESTRICCION: Record<string, string> = { fuera_horario: 'Fuera de horario', no_iniciada: 'Permiso aún no vigente', vencida: 'Permiso vencido' };

/**
 * Inicio del Gestor de accesos: lo que necesita decidir hoy (solicitudes pendientes, permisos
 * por vencer, accesos denegados y placas reincidentes), con acceso directo a cada acción.
 */
const PanelAccesos: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const notificar = useNotificar();
  const [registrando, setRegistrando] = useState<string | null>(null);
  const { datos: p, cargando, error, recargar } = useConsulta<Panel>(() => api.get('/panel/accesos').then(r => r.data), []);
  const diferido = useDiferido(() => recargar(true), 3000);
  useEvento('solicitudes:actualizadas', diferido);
  useEvento('listas:actualizadas', diferido);
  useEvento('deteccion:actualizada', diferido);

  return (
    <div className="pagina">
      <div className="fila" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 21, fontWeight: 800 }}>Gestión de accesos · {user?.nombre.split(' ')[0]}</h2>
          <p className="texto-secundario">Permisos de placa, solicitudes y accesos denegados · {p ? `actualizado ${relativo(p.generado)}` : 'cargando…'}</p>
        </div>
        <div className="fila">
          <Link to="/solicitudes" className="btn btn-secondary"><FileCheck2 size={16} /> Solicitudes</Link>
          <button className="btn btn-navy" onClick={() => setRegistrando('')}><Plus size={16} /> Nuevo permiso</button>
        </div>
      </div>
      {error && <Aviso tipo="error" style={{ marginBottom: 16 }}>{error}</Aviso>}

      <div className="pila">
        <div className="grid-kpi">
          <Kpi etiqueta="Solicitudes pendientes" valor={numero(p?.solicitudes.pendientes)} icono={<FileCheck2 size={17} />} cargando={cargando}
            color="var(--pendiente)" fondo="var(--pendiente-bg)" onClick={() => navigate('/solicitudes')}
            pie={p?.solicitudes.ultimas[0] ? `La más antigua: ${relativo(p.solicitudes.ultimas[0].fecha_solicitud)}` : 'Al día'} />
          <Kpi etiqueta="Permisos vigentes" valor={numero(p?.padron.vigentes)} icono={<ShieldCheck size={17} />} cargando={cargando}
            color="var(--autorizado)" fondo="var(--autorizado-bg)" onClick={() => navigate('/listas/autorizados')}
            pie={p ? `${numero(p.padron.con_horario)} con horario · ${numero(p.padron.por_iniciar)} por iniciar` : undefined} />
          <Kpi etiqueta={`Vencen en ${p?.padron.dias_aviso ?? 7} días`} valor={numero(p?.padron.por_vencer)} icono={<CalendarClock size={17} />} cargando={cargando}
            color="var(--no-registrado)" fondo="var(--no-registrado-bg)" onClick={() => navigate('/listas/autorizados?vigencia=por_vencer')}
            pie={p ? `${numero(p.padron.vencidos)} vencidos sin retirar` : undefined} />
          <Kpi etiqueta="Accesos denegados hoy" valor={numero(p ? p.hoy.sin_permiso + p.hoy.restringidos : undefined)} icono={<ShieldX size={17} />} cargando={cargando}
            color="var(--alerta)" fondo="var(--alerta-bg)" onClick={() => navigate('/detecciones?estado=no_reconocido')}
            pie={p ? `${numero(p.hoy.sin_permiso)} sin permiso · ${numero(p.hoy.restringidos)} fuera de horario/vigencia` : undefined} />
        </div>

        {p && (
          <div className="grid-principal">
            <Tarjeta titulo="Solicitudes por resolver" subtitulo="En orden de llegada" sinPadding
              acciones={<Link to="/solicitudes" className="btn btn-ghost btn-sm">Ver todas</Link>}>
              {p.solicitudes.ultimas.length === 0 ? <Vacio titulo="No hay solicitudes pendientes" /> : (
                <div className="tabla-contenedor"><table className="tabla"><tbody>
                  {p.solicitudes.ultimas.map(s => (
                    <tr key={s.id} className="clic" onClick={() => navigate(`/solicitudes?id=${s.id}`)}>
                      <td><Placa valor={s.placa} /></td>
                      <td><strong style={{ color: 'var(--text)', fontWeight: 600 }}>{s.propietario}</strong>
                        <span className="secundario truncar" style={{ maxWidth: 320 }}>{CATEGORIAS_PERMISO[s.categoria] ?? s.categoria} · {s.motivo}</span></td>
                      <td className="ocultar-movil"><span className="texto-secundario">{s.solicitante}</span><span className="secundario">{relativo(s.fecha_solicitud)}</span></td>
                    </tr>
                  ))}
                </tbody></table></div>
              )}
            </Tarjeta>

            <Tarjeta titulo="Placas reincidentes sin permiso" subtitulo="Últimos 7 días · ¿registrarlas o investigarlas?" sinPadding>
              {p.reincidentes.length === 0 ? <Vacio titulo="Sin reincidencias" icono={<Repeat size={20} />} /> : (
                <div className="tabla-contenedor"><table className="tabla"><tbody>
                  {p.reincidentes.map(r => (
                    <tr key={r.placa}>
                      <td><Placa valor={r.placa} /></td>
                      <td className="num"><b>{numero(r.intentos)}</b> <span className="texto-secundario">intentos</span></td>
                      <td className="ocultar-movil texto-secundario">{relativo(r.ultimo)}</td>
                      <td className="acciones-celda">
                        <Link className="btn btn-ghost btn-sm" to={`/detecciones?placa=${r.placa}`}>Historial</Link>
                        <button className="btn btn-secondary btn-sm" onClick={() => setRegistrando(r.placa)}><Plus size={13} /> Permiso</button>
                      </td>
                    </tr>
                  ))}
                </tbody></table></div>
              )}
            </Tarjeta>
          </div>
        )}

        {p && (
          <div className="grid-principal">
            <Tarjeta titulo="Accesos denegados recientes" subtitulo="Sin permiso o fuera del horario/vigencia del permiso" sinPadding>
              {p.denegados_recientes.length === 0 ? <Vacio titulo="Sin accesos denegados en la semana" icono={<ShieldOff size={20} />} /> : (
                <div className="tabla-contenedor"><table className="tabla"><tbody>
                  {p.denegados_recientes.map(d => (
                    <tr key={d.id} className="clic" onClick={() => navigate(`/detecciones/${d.id}`)}>
                      <td><Placa valor={d.placa} /></td>
                      <td>{d.restriccion_acceso
                        ? <span className="insignia no_reconocido"><Clock size={12} /> {RESTRICCION[d.restriccion_acceso]}</span>
                        : <span className="insignia alerta">Sin permiso</span>}
                        {d.autorizado && <span className="secundario">{d.autorizado.propietario}</span>}</td>
                      <td className="ocultar-movil"><span className="texto-secundario">{fechaHora(d.fecha_hora_ingreso)}</span><span className="secundario">{d.camara?.nombre ?? '—'}</span></td>
                    </tr>
                  ))}
                </tbody></table></div>
              )}
            </Tarjeta>
            <Tarjeta titulo="Permisos por categoría">
              {Object.keys(p.categorias).length === 0 ? <Vacio titulo="El padrón está vacío" /> : (
                <ul className="lista-simple" style={{ margin: '-8px -16px' }}>
                  {Object.entries(p.categorias).sort((a, b) => b[1] - a[1]).map(([c, n]) => (
                    <li key={c}><span style={{ flex: 1 }}>{CATEGORIAS_PERMISO[c] ?? c}</span><b>{numero(n)}</b></li>
                  ))}
                </ul>
              )}
              <p className="texto-secundario" style={{ marginTop: 14, fontSize: 12 }}>Actualizado a las {hora(p.generado)}.</p>
            </Tarjeta>
          </div>
        )}
      </div>

      {registrando !== null && (
        <FormularioLista tipo="autorizados" inicial={registrando ? { placa: registrando } : undefined} onCerrar={() => setRegistrando(null)}
          onGuardado={r => { setRegistrando(null); notificar('exito', `Permiso registrado para ${r.placa}`); recargar(true); }} />
      )}
    </div>
  );
};

export default PanelAccesos;
