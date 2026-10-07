import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, KeyRound, Lock, Save, UserCircle } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { fechaHora, iniciales, ROLES } from '../../dominio/formato';
import { passwordValida, REGLAS_PASSWORD } from '../../dominio/password';
import { erroresTexto, sinErrores } from '../../dominio/validacion';
import { REGLAS_USUARIO } from '../../dominio/reglas';
import { Aviso, Tarjeta } from '../componentes/ui';
import { CampoTexto } from '../componentes/campos';
import { useNotificar } from '../componentes/Notificaciones';
import { ETIQUETA_PERMISO } from '../../dominio/permisos';

const CampoClave: React.FC<{ id: string; etiqueta: string; valor: string; onCambiar: (v: string) => void; autoComplete: string }> = ({ id, etiqueta, valor, onCambiar, autoComplete }) => {
  const [ver, setVer] = useState(false);
  return (
    <div className="campo">
      <label htmlFor={id}>{etiqueta}</label>
      <div style={{ position: 'relative' }}>
        <input id={id} className="input" type={ver ? 'text' : 'password'} value={valor} onChange={e => onCambiar(e.target.value)} autoComplete={autoComplete} maxLength={128} style={{ paddingRight: 40 }} />
        <button type="button" className="btn btn-ghost btn-sm btn-icono" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => setVer(v => !v)} aria-label={ver ? 'Ocultar' : 'Mostrar'}>
          {ver ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
};

const Perfil: React.FC = () => {
  const { user, refrescarUsuario } = useAuth();
  const notificar = useNotificar();
  const { hash } = useLocation();
  const refClave = useRef<HTMLDivElement>(null);
  const [datos, setDatos] = useState({ nombre_completo: user?.nombre ?? '', cargo: user?.cargo ?? '' });
  const [guardando, setGuardando] = useState(false);
  const [clave, setClave] = useState({ actual: '', nueva: '', confirmar: '' });
  const [cambiando, setCambiando] = useState(false);
  const [errorClave, setErrorClave] = useState<string | null>(null);

  useEffect(() => { if (hash === '#contrasena') refClave.current?.scrollIntoView({ behavior: 'smooth' }); }, [hash]);
  if (!user) return null;

  const cambiosDatos = datos.nombre_completo.trim() !== user.nombre || (datos.cargo.trim() || null) !== (user.cargo || null);
  // Mismas reglas que la API (leerPerfil): nombre obligatorio solo con letras y cargo alfanumérico
  const datosValidos = sinErrores(erroresTexto(datos, REGLAS_USUARIO));
  const guardarDatos = async (e: React.FormEvent) => {
    e.preventDefault();
    setGuardando(true);
    try {
      await api.put('/auth/perfil', datos);
      await refrescarUsuario();
      notificar('exito', 'Perfil actualizado');
    } catch (err) {
      notificar('error', 'No se pudo guardar', mensajeError(err));
    } finally { setGuardando(false); }
  };

  const claveValida = clave.actual && passwordValida(clave.nueva) && clave.nueva === clave.confirmar && clave.nueva !== clave.actual;
  const cambiarClave = async (e: React.FormEvent) => {
    e.preventDefault();
    setCambiando(true);
    setErrorClave(null);
    try {
      await api.post('/auth/cambiar-password', { actual: clave.actual, nueva: clave.nueva });
      setClave({ actual: '', nueva: '', confirmar: '' });
      notificar('exito', 'Contraseña actualizada', 'Recibirá un correo de confirmación.');
    } catch (err) {
      setErrorClave(mensajeError(err));
    } finally { setCambiando(false); }
  };

  return (
    <div className="pagina" style={{ maxWidth: 1100 }}>
      <div className="grid-principal" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)' }}>
        <div className="pila">
          <Tarjeta>
            <div className="pila" style={{ alignItems: 'center', textAlign: 'center', gap: 10 }}>
              <span className="avatar" style={{ width: 72, height: 72, fontSize: 24 }}>{iniciales(user.nombre)}</span>
              <div><h2 style={{ fontSize: 18 }}>{user.nombre}</h2><p className="texto-secundario">{user.email}</p></div>
              <span className="insignia info">{ROLES[user.rol]}</span>
            </div>
            <dl className="definiciones" style={{ marginTop: 18 }}>
              <dt>Cargo</dt><dd>{user.cargo || '—'}</dd>
              <dt>Último acceso</dt><dd>{fechaHora(user.fecha_ultimo_acceso)}</dd>
              <dt>Cuenta creada</dt><dd>{fechaHora(user.fecha_creacion)}</dd>
            </dl>
          </Tarjeta>
          <Tarjeta titulo="Permisos de su rol">
            <ul style={{ listStyle: 'none', display: 'grid', gap: 8, fontSize: 13 }}>
              {(user.permisos ?? []).map(p => <li key={p} className="fila" style={{ gap: 8, flexWrap: 'nowrap' }}><CheckCircle2 size={15} color="var(--autorizado)" />{ETIQUETA_PERMISO[p] ?? p}</li>)}
            </ul>
            <p className="texto-secundario" style={{ marginTop: 12 }}>El rol lo asigna el administrador del sistema.</p>
          </Tarjeta>
        </div>

        <div className="pila">
          <Tarjeta titulo="Datos personales" acciones={<UserCircle size={18} color="var(--text-3)" />}>
            <form className="form-grid" onSubmit={guardarDatos}>
              <CampoTexto id="p-nombre" className="completo" etiqueta="Nombres y apellidos*" valor={datos.nombre_completo} autoComplete="name"
                onCambiar={v => setDatos(d => ({ ...d, nombre_completo: v }))} regla={REGLAS_USUARIO.nombre_completo} />
              <CampoTexto id="p-cargo" etiqueta="Cargo" valor={datos.cargo} autoComplete="organization-title"
                onCambiar={v => setDatos(d => ({ ...d, cargo: v }))} regla={REGLAS_USUARIO.cargo} />
              <div className="campo"><label htmlFor="p-email">Correo (usuario de acceso)</label>
                <input id="p-email" className="input" value={user.email} disabled /></div>
              <div className="completo fila" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-navy" disabled={!cambiosDatos || guardando || !datosValidos}><Save size={15} /> Guardar cambios</button>
              </div>
            </form>
          </Tarjeta>

          <div ref={refClave} id="contrasena">
            <Tarjeta titulo="Cambiar contraseña" acciones={<KeyRound size={18} color="var(--text-3)" />}>
              <form className="pila" onSubmit={cambiarClave} style={{ gap: 14 }}>
                <CampoClave id="p-actual" etiqueta="Contraseña actual" valor={clave.actual} onCambiar={v => setClave({ ...clave, actual: v })} autoComplete="current-password" />
                <div className="form-grid">
                  <CampoClave id="p-nueva" etiqueta="Nueva contraseña" valor={clave.nueva} onCambiar={v => setClave({ ...clave, nueva: v })} autoComplete="new-password" />
                  <CampoClave id="p-conf" etiqueta="Confirmar nueva contraseña" valor={clave.confirmar} onCambiar={v => setClave({ ...clave, confirmar: v })} autoComplete="new-password" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 6 }}>
                  {REGLAS_PASSWORD.map(r => {
                    const ok = r.ok(clave.nueva);
                    return <span key={r.texto} className="fila" style={{ gap: 6, fontSize: 12, color: ok ? 'var(--autorizado)' : 'var(--text-3)' }}>{ok ? <CheckCircle2 size={13} /> : <Lock size={13} />}{r.texto}</span>;
                  })}
                  <span className="fila" style={{ gap: 6, fontSize: 12, color: clave.confirmar && clave.confirmar === clave.nueva ? 'var(--autorizado)' : 'var(--text-3)' }}>
                    {clave.confirmar && clave.confirmar === clave.nueva ? <CheckCircle2 size={13} /> : <Lock size={13} />}Las contraseñas coinciden</span>
                </div>
                {errorClave && <Aviso tipo="error">{errorClave}</Aviso>}
                <div className="fila" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary" disabled={!claveValida || cambiando}><KeyRound size={15} /> {cambiando ? 'Actualizando…' : 'Cambiar contraseña'}</button>
                </div>
              </form>
            </Tarjeta>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Perfil;
