import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Edit3, KeyRound, Lock, LockOpen, Mail, Plus, Search, ShieldCheck, UserPlus, UserX } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { useConsulta } from '../../aplicacion/hooks';
import type { UsuarioAdmin } from '../../dominio/tipos';
import { fechaHora, iniciales, relativo, ROLES } from '../../dominio/formato';
import { errorCorreoInstitucional, errorDe, sinErrores, validarTexto } from '../../dominio/validacion';
import { REGLA_MOTIVO_BAJA, REGLAS_USUARIO } from '../../dominio/reglas';
import { Aviso, Confirmar, FilasEsqueleto, Kpi, Modal, Tarjeta, Vacio } from '../componentes/ui';
import { CampoTexto } from '../componentes/campos';
import { useNotificar } from '../componentes/Notificaciones';
import { DESCRIPCION_ROL, ROLES_ORDEN } from '../../dominio/permisos';
import type { Rol } from '../../dominio/permisos';
import { obtenerEstadoSistema } from './auth/componentes';

const COLOR_ROL: Record<Rol, string> = { Admin: 'var(--rojo)', GestorPermisos: '#0f766e', Guardia: '#64748b' };

function estadoCuenta(u: UsuarioAdmin): { texto: string; clase: string } {
  if (u.bloqueado) return { texto: 'Bloqueada', clase: 'alerta' };
  if (u.bloqueo_temporal_hasta) return { texto: 'Bloqueo temporal', clase: 'no_reconocido' };
  if (u.estado === 'pendiente') return { texto: 'Correo sin verificar', clase: 'pendiente_revision' };
  if (u.estado === 'inactivo') return { texto: 'Inactiva', clase: 'neutro' };
  return { texto: 'Activa', clase: 'autorizado' };
}

/** Correo: sin espacios (se escribe tal cual; la API lo guarda en minúsculas). */
const sinEspacios = (v: string) => v.replace(/\s/g, '');

const FormularioUsuario: React.FC<{ usuario?: UsuarioAdmin; esPropio?: boolean; onCerrar: () => void; onGuardado: (u: UsuarioAdmin, msg: string) => void }> = ({ usuario, esPropio, onCerrar, onGuardado }) => {
  const [f, setF] = useState({
    nombre_completo: usuario?.nombre_completo ?? '', email: usuario?.email ?? '', cargo: usuario?.cargo ?? '',
    rol: (usuario?.rol ?? 'Guardia') as Rol, estado: usuario?.estado ?? 'activo',
  });
  const [dominios, setDominios] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Dominios institucionales de la configuración: el correo de una cuenta nueva se valida como en la API
  useEffect(() => {
    if (!usuario) obtenerEstadoSistema().then(e => setDominios(e.dominios_permitidos ?? [])).catch(() => undefined);
  }, [usuario]);

  // Como en la API (leerEdicionUsuario), al editar solo se valida y envía el dato que cambia
  const cambiaNombre = !usuario || f.nombre_completo !== usuario.nombre_completo;
  const cambiaCargo = !usuario || f.cargo !== (usuario.cargo ?? '');
  const errores = {
    nombre: cambiaNombre ? errorDe(validarTexto(f.nombre_completo, REGLAS_USUARIO.nombre_completo)) : null,
    cargo: cambiaCargo ? errorDe(validarTexto(f.cargo, REGLAS_USUARIO.cargo)) : null,
    email: usuario ? null : errorCorreoInstitucional(f.email, dominios, 'Correo institucional'),
  };
  const valido = sinErrores(errores);

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = usuario
        ? await api.put(`/usuarios/${usuario.id}`, {
          ...(cambiaNombre ? { nombre_completo: f.nombre_completo } : {}), ...(cambiaCargo ? { cargo: f.cargo } : {}), rol: f.rol, estado: f.estado,
        })
        : await api.post('/usuarios', { nombre_completo: f.nombre_completo, email: f.email.trim().toLowerCase(), cargo: f.cargo, rol: f.rol });
      onGuardado(r.data.usuario, r.data.message);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={usuario ? 'Editar usuario' : 'Nuevo usuario'} subtitulo={usuario ? usuario.email : 'La persona recibirá un correo para definir su propia contraseña.'}
      onCerrar={onCerrar} bloquear={enviando}
      pie={<><button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-navy" onClick={guardar} disabled={!valido || enviando}>{usuario ? 'Guardar cambios' : 'Crear y enviar invitación'}</button></>}>
      <div className="form-grid">
        <CampoTexto id="u-nombre" className="completo" etiqueta="Nombres y apellidos*" valor={f.nombre_completo} autoFocus autoComplete="off"
          onCambiar={v => setF(x => ({ ...x, nombre_completo: v }))} regla={REGLAS_USUARIO.nombre_completo} error={errores.nombre} />
        {!usuario && (
          <CampoTexto id="u-email" etiqueta="Correo institucional*" tipo="email" valor={f.email} autoComplete="off"
            onCambiar={v => setF(x => ({ ...x, email: v }))} regla={{ etiqueta: 'Correo institucional', tipo: 'libre', max: 150, requerido: true }}
            error={errores.email} filtrar={sinEspacios} placeholder={dominios[0] ? `usuario@${dominios[0]}` : undefined} />
        )}
        <CampoTexto id="u-cargo" etiqueta="Cargo" valor={f.cargo} onCambiar={v => setF(x => ({ ...x, cargo: v }))}
          regla={REGLAS_USUARIO.cargo} error={errores.cargo} placeholder="Ej.: Agente de seguridad" />
        <div className="campo completo">
          <span className="etiqueta-campo">Rol*</span>
          <div className="grid-2" style={{ gap: 8 }}>
            {ROLES_ORDEN.map(r => (
              <label key={r} className={`tarjeta`} style={{ padding: 12, cursor: esPropio ? 'not-allowed' : 'pointer', borderColor: f.rol === r ? 'var(--navy-700)' : undefined, boxShadow: f.rol === r ? '0 0 0 2px rgba(21,49,93,0.15)' : undefined, opacity: esPropio && f.rol !== r ? 0.5 : 1 }}>
                <span className="fila" style={{ gap: 8 }}>
                  <input type="radio" name="rol" checked={f.rol === r} disabled={esPropio} onChange={() => setF({ ...f, rol: r })} />
                  <strong style={{ fontSize: 13 }}>{ROLES[r]}</strong>
                </span>
                <span className="texto-secundario" style={{ display: 'block', fontSize: 11.5, marginTop: 4 }}>{DESCRIPCION_ROL[r]}</span>
              </label>
            ))}
          </div>
        </div>
        {usuario && (
          <div className="campo"><label htmlFor="u-estado">Estado de la cuenta</label>
            <select id="u-estado" className="select" value={f.estado} disabled={esPropio} onChange={e => setF({ ...f, estado: e.target.value as UsuarioAdmin['estado'] })}>
              <option value="activo">Activa</option><option value="inactivo">Inactiva</option>{usuario.estado === 'pendiente' && <option value="pendiente">Pendiente de verificación</option>}
            </select></div>
        )}
        {esPropio && <div className="completo"><Aviso tipo="info">No puede cambiar su propio rol ni desactivar su cuenta.</Aviso></div>}
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
    </Modal>
  );
};

const Usuarios: React.FC = () => {
  const { user } = useAuth();
  const notificar = useNotificar();
  const { datos, cargando, error, recargar, setDatos } = useConsulta<UsuarioAdmin[]>(() => api.get('/usuarios').then(r => r.data), []);
  const [busqueda, setBusqueda] = useState('');
  const [rol, setRol] = useState('');
  const [estado, setEstado] = useState('');
  const [editando, setEditando] = useState<UsuarioAdmin | 'nuevo' | null>(null);
  const [accion, setAccion] = useState<{ tipo: 'bloquear' | 'desbloquear' | 'enlace' | 'baja'; u: UsuarioAdmin } | null>(null);

  const reemplazar = (u: UsuarioAdmin) => setDatos(l => l && (l.some(x => x.id === u.id) ? l.map(x => (x.id === u.id ? u : x)) : [u, ...l]));

  /** La edición parte de la versión vigente de la cuenta (otro administrador pudo cambiarla); si no responde, de la del listado. */
  const editar = async (u: UsuarioAdmin) => {
    try {
      const r = await api.get(`/usuarios/${u.id}`);
      const actual: UsuarioAdmin | undefined = r.data?.usuario ?? r.data;
      if (actual?.id === u.id) { reemplazar(actual); setEditando(actual); return; }
    } catch { /* se edita con los datos del listado */ }
    setEditando(u);
  };

  const filas = useMemo(() => (datos ?? []).filter(u => {
    const q = busqueda.trim().toLowerCase();
    return (!q || u.nombre_completo.toLowerCase().includes(q) || u.email.includes(q) || (u.cargo ?? '').toLowerCase().includes(q))
      && (!rol || u.rol === rol) && (!estado || estadoCuenta(u).texto === estado);
  }), [datos, busqueda, rol, estado]);

  const c = useMemo(() => {
    const l = datos ?? [];
    return { total: l.length, activos: l.filter(u => estadoCuenta(u).texto === 'Activa').length, pendientes: l.filter(u => u.estado === 'pendiente').length, bloqueados: l.filter(u => u.bloqueado || u.bloqueo_temporal_hasta).length };
  }, [datos]);

  return (
    <div className="pagina">
      <div className="pila">
        <div className="grid-kpi">
          <Kpi etiqueta="Cuentas" valor={c.total} icono={<ShieldCheck size={17} />} />
          <Kpi etiqueta="Activas" valor={c.activos} color="var(--autorizado)" fondo="var(--autorizado-bg)" icono={<ShieldCheck size={17} />} />
          <Kpi etiqueta="Correo sin verificar" valor={c.pendientes} color="var(--pendiente)" fondo="var(--pendiente-bg)" icono={<Mail size={17} />} />
          <Kpi etiqueta="Bloqueadas" valor={c.bloqueados} color="var(--alerta)" fondo="var(--alerta-bg)" icono={<Lock size={17} />} />
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Tarjeta titulo="Personal con acceso al sistema" subtitulo="Las contraseñas nunca las define ni las conoce el administrador: cada persona crea la suya con un enlace."
          acciones={<>
            <Link to="/auditoria?fuente=cuentas" className="btn btn-secondary btn-sm">Auditoría de cuentas</Link>
            <button className="btn btn-navy btn-sm" onClick={() => setEditando('nuevo')}><UserPlus size={14} /> Nuevo usuario</button>
          </>} sinPadding>
          <div className="filtros" style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <div className="campo crece" style={{ maxWidth: 360 }}>
              <div className="input-icono"><Search size={15} /><input className="input" value={busqueda} onChange={e => setBusqueda(e.target.value)} maxLength={100} placeholder="Nombre, correo o cargo" aria-label="Buscar usuario" /></div>
            </div>
            <select className="select" style={{ width: 'auto' }} value={rol} onChange={e => setRol(e.target.value)} aria-label="Rol">
              <option value="">Todos los roles</option>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className="select" style={{ width: 'auto' }} value={estado} onChange={e => setEstado(e.target.value)} aria-label="Estado">
              <option value="">Todos los estados</option>{['Activa', 'Correo sin verificar', 'Inactiva', 'Bloqueada', 'Bloqueo temporal'].map(x => <option key={x}>{x}</option>)}
            </select>
          </div>
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th className="ocultar-movil">Último acceso</th><th className="ocultar-movil">Alta</th><th /></tr></thead>
              <tbody>
                {cargando && !datos ? <FilasEsqueleto columnas={6} /> : filas.map(u => {
                  const e = estadoCuenta(u);
                  const propio = u.id === user?.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="fila" style={{ gap: 10, flexWrap: 'nowrap' }}>
                          <span className="avatar" style={{ width: 32, height: 32, fontSize: 12, background: COLOR_ROL[u.rol] ?? '#64748b' }}>{iniciales(u.nombre_completo)}</span>
                          <div style={{ minWidth: 0 }}>
                            <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{u.nombre_completo}{propio && <span className="texto-secundario"> (usted)</span>}</strong>
                            <span className="secundario">{u.email}{u.cargo ? ` · ${u.cargo}` : ''}</span>
                          </div>
                        </div>
                      </td>
                      <td>{ROLES[u.rol]}</td>
                      <td><span className={`insignia ${e.clase}`}>{e.texto}</span>
                        {u.bloqueo_temporal_hasta && <span className="secundario">hasta {fechaHora(u.bloqueo_temporal_hasta)}</span>}</td>
                      <td className="ocultar-movil">{u.fecha_ultimo_acceso ? relativo(u.fecha_ultimo_acceso) : <span className="texto-secundario">Nunca</span>}</td>
                      <td className="ocultar-movil"><span className="texto-secundario">{fechaHora(u.fecha_creacion)}</span><span className="secundario">{u.creado_por ? `por ${u.creado_por}` : 'registro propio'}</span></td>
                      <td className="acciones-celda">
                        <button className="btn btn-ghost btn-sm btn-icono" title="Editar" aria-label="Editar" onClick={() => editar(u)}><Edit3 size={15} /></button>
                        <button className="btn btn-ghost btn-sm btn-icono" title="Enviar enlace para definir contraseña" aria-label="Enviar enlace de contraseña" onClick={() => setAccion({ tipo: 'enlace', u })}><KeyRound size={15} /></button>
                        {u.bloqueado || u.bloqueo_temporal_hasta
                          ? <button className="btn btn-ghost btn-sm btn-icono" title="Desbloquear" aria-label="Desbloquear" onClick={() => setAccion({ tipo: 'desbloquear', u })}><LockOpen size={15} color="var(--autorizado)" /></button>
                          : !propio && <button className="btn btn-ghost btn-sm btn-icono" title="Bloquear" aria-label="Bloquear" onClick={() => setAccion({ tipo: 'bloquear', u })}><Lock size={15} color="var(--alerta)" /></button>}
                        {/* La propia cuenta no se da de baja (la API responde 403) */}
                        {!propio && u.estado !== 'inactivo' && (
                          <button className="btn btn-ghost btn-sm btn-icono" title="Dar de baja" aria-label={`Dar de baja a ${u.nombre_completo}`} onClick={() => setAccion({ tipo: 'baja', u })}><UserX size={15} color="var(--alerta)" /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {datos && filas.length === 0 && <Vacio titulo="Sin usuarios que coincidan" accion={<button className="btn btn-secondary btn-sm" onClick={() => setEditando('nuevo')}><Plus size={14} /> Nuevo usuario</button>} />}
        </Tarjeta>
      </div>

      {editando && (
        <FormularioUsuario usuario={editando === 'nuevo' ? undefined : editando} esPropio={editando !== 'nuevo' && editando.id === user?.id}
          onCerrar={() => setEditando(null)} onGuardado={(u, msg) => { reemplazar(u); setEditando(null); notificar('exito', msg); }} />
      )}
      {accion && accion.tipo === 'baja' && (
        <Confirmar titulo="Dar de baja la cuenta" peligro pedirMotivo reglaMotivo={REGLA_MOTIVO_BAJA} textoBoton="Dar de baja"
          mensaje={<div className="pila" style={{ gap: 8 }}>
            <p><b>{accion.u.nombre_completo}</b> ({accion.u.email}) no podrá iniciar sesión y sus sesiones abiertas se cerrarán en segundos.</p>
            <p className="texto-secundario">Es una baja lógica: la cuenta, su historial y su auditoría se conservan. Puede reactivarse editando su estado.</p>
          </div>}
          onConfirmar={async motivo => {
            try {
              // 403: la propia cuenta · 409: ya dada de baja o único administrador activo
              const r = await api.delete(`/usuarios/${accion.u.id}`, { data: { motivo } });
              if (r.data?.usuario) reemplazar(r.data.usuario);
              notificar('exito', r.data?.message ?? 'Cuenta dada de baja.', 'La baja quedó registrada en la auditoría de cuentas.');
            } catch (e) { throw new Error(mensajeError(e)); }
          }}
          onCerrar={() => { setAccion(null); recargar(true); }} />
      )}
      {accion && accion.tipo !== 'baja' && (
        <Confirmar
          titulo={accion.tipo === 'bloquear' ? 'Bloquear cuenta' : accion.tipo === 'desbloquear' ? 'Desbloquear cuenta' : 'Enviar enlace de contraseña'}
          peligro={accion.tipo === 'bloquear'} pedirMotivo={accion.tipo === 'bloquear'}
          textoBoton={accion.tipo === 'bloquear' ? 'Bloquear' : accion.tipo === 'desbloquear' ? 'Desbloquear' : 'Enviar enlace'}
          mensaje={accion.tipo === 'bloquear'
            ? <><b>{accion.u.nombre_completo}</b> no podrá ingresar y sus sesiones abiertas se cerrarán en segundos.</>
            : accion.tipo === 'desbloquear'
              ? <>Se quitarán los bloqueos de <b>{accion.u.nombre_completo}</b> y se reiniciará el contador de intentos fallidos.</>
              : <>Se enviará a <b>{accion.u.email}</b> un enlace de un solo uso (30 minutos) para definir una nueva contraseña.</>}
          onConfirmar={async motivo => {
            try {
              const r = accion.tipo === 'enlace'
                ? await api.post(`/usuarios/${accion.u.id}/restablecer-password`)
                : await api.post(`/usuarios/${accion.u.id}/${accion.tipo}`, { motivo });
              if (r.data.usuario) reemplazar(r.data.usuario);
              notificar('exito', r.data.message);
            } catch (e) { throw new Error(mensajeError(e)); }
          }}
          onCerrar={() => { setAccion(null); recargar(true); }} />
      )}
    </div>
  );
};

export default Usuarios;
