import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Mail, User, Briefcase } from 'lucide-react';
import api, { mensajeError } from '../../../infraestructura/api';
import { ErrorAcceso, useAuth } from '../../../aplicacion/AuthContext';
import { errorCorreoInstitucional, errorDe, filtrarTexto, sinErrores, validarTexto } from '../../../dominio/validacion';
import { REGLAS_USUARIO } from '../../../dominio/reglas';
import { filtrarEscrito } from '../../componentes/campos';
import {
  Aviso, Boton, Campo, CampoPassword, Declaracion, Encabezado, PanelImagen, ParPassword,
  PantallaCarga, UsoExclusivo, passwordValida, useEstadoSistema, useTocados,
} from './componentes';
import OlvidePasswordModal from './OlvidePasswordModal';

/**
 * Inicio de sesión y registro en una sola pantalla con el panel de imagen deslizante
 * (mismo patrón que Vigilance Heart). /login y /registro montan este componente, así
 * que el cambio de ruta anima el panel en lugar de recargar la página.
 */
const Acceso: React.FC = () => {
  const { user, login, motivoCierre } = useAuth();
  const { estado, error: errorEstado } = useEstadoSistema();
  const location = useLocation();
  const navigate = useNavigate();
  const modo: 'login' | 'registro' = location.pathname === '/registro' ? 'registro' : 'login';
  const destino = (location.state as { desde?: string } | null)?.desde || '/';

  /* ─── Login ─── */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cargandoLogin, setCargandoLogin] = useState(false);
  const [errorLogin, setErrorLogin] = useState<string | null>(null);
  const [sinVerificar, setSinVerificar] = useState<string | null>(null);
  const [olvideAbierto, setOlvideAbierto] = useState(false);

  /* ─── Registro ─── */
  const [reg, setReg] = useState({ nombre: '', cargo: '', email: '', password: '', confirmar: '' });
  const { tocado, tocar, reiniciar } = useTocados<'nombre' | 'cargo' | 'email'>();
  const [declaracion, setDeclaracion] = useState(false);
  const [cargandoRegistro, setCargandoRegistro] = useState(false);
  const [errorRegistro, setErrorRegistro] = useState<string | null>(null);
  const [registrado, setRegistrado] = useState<{ email: string; mensaje: string } | null>(null);

  /* ─── Reenvío de verificación ─── */
  const [reenviando, setReenviando] = useState(false);
  const [mensajeReenvio, setMensajeReenvio] = useState<string | null>(null);

  useEffect(() => { setErrorLogin(null); setErrorRegistro(null); setMensajeReenvio(null); }, [modo]);

  if (user) return <Navigate to={destino} replace />;
  if (!estado && !errorEstado) return <PantallaCarga texto="CONECTANDO CON EL SISTEMA…" />;
  if (estado?.configuracion_inicial_requerida) return <Navigate to="/configuracion-inicial" replace />;
  if (estado && !estado.registro_habilitado && modo === 'registro') return <Navigate to="/login" replace />;

  const dominios = estado?.dominios_permitidos;
  const ejemploCorreo = `usuario@${dominios?.[0] ?? 'ecu911.gob.ec'}`;
  const cambiarModo = (m: 'login' | 'registro') => navigate(m === 'registro' ? '/registro' : '/login', { replace: true });

  const enviarLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setErrorLogin('Ingrese su correo y contraseña.'); return; }
    setCargandoLogin(true);
    setErrorLogin(null);
    setSinVerificar(null);
    setMensajeReenvio(null);
    try {
      await login(email, password);
      navigate(destino, { replace: true });
    } catch (err) {
      const e2 = err as ErrorAcceso;
      if (e2.codigo === 'EMAIL_NO_VERIFICADO') setSinVerificar(email.trim().toLowerCase());
      else setErrorLogin(e2.message);
      setPassword('');
    } finally {
      setCargandoLogin(false);
    }
  };

  const reenviarVerificacion = async (correo: string) => {
    setReenviando(true);
    try {
      const r = await api.post('/auth/reenviar-verificacion', { email: correo });
      setMensajeReenvio(r.data.message || 'Si la cuenta está pendiente, se envió un nuevo enlace.');
    } catch (err) {
      setMensajeReenvio(mensajeError(err));
    } finally {
      setReenviando(false);
    }
  };

  // Mismas reglas que la API (dominio/usuarios.ts → leerRegistro)
  const erroresRegistro = {
    nombre: errorDe(validarTexto(reg.nombre, REGLAS_USUARIO.nombre_completo)),
    cargo: errorDe(validarTexto(reg.cargo, REGLAS_USUARIO.cargo)),
    email: errorCorreoInstitucional(reg.email, dominios),
  };
  const errorCorreoRegistro = erroresRegistro.email;
  const puedeRegistrar = sinErrores(erroresRegistro) && passwordValida(reg.password) && reg.password === reg.confirmar && declaracion;

  const enviarRegistro = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!puedeRegistrar) return;
    setCargandoRegistro(true);
    setErrorRegistro(null);
    try {
      const correo = reg.email.trim().toLowerCase();
      const r = await api.post('/auth/registro', {
        nombre_completo: reg.nombre.trim(), cargo: reg.cargo.trim() || undefined, email: correo, password: reg.password,
      });
      setRegistrado({ email: correo, mensaje: r.data.message });
      setReg({ nombre: '', cargo: '', email: '', password: '', confirmar: '' });
      reiniciar();
      setDeclaracion(false);
    } catch (err) {
      setErrorRegistro(mensajeError(err, 'No se pudo completar el registro.'));
    } finally {
      setCargandoRegistro(false);
    }
  };

  /** Cambio de un campo del registro; con `limpiar`, los caracteres no admitidos no llegan a escribirse. */
  const campoReg = (k: keyof typeof reg, limpiar?: (v: string) => string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const valor = limpiar ? filtrarEscrito(e.target, limpiar) : e.target.value;
    setReg(r => ({ ...r, [k]: valor }));
  };

  return (
    <div className="auth-root" data-lado={modo === 'login' ? 'derecha' : 'izquierda'}>
      <PanelImagen />

      {/* ── LOGIN (mitad izquierda) ── */}
      <section className={`auth-lado izquierda ${modo === 'login' ? 'visible' : 'oculto'}`} aria-hidden={modo !== 'login'}>
        <div className="auth-caja">
          <Encabezado sobre="Servicio Integrado de Seguridad" titulo="ECU 911"
            subtitulo="Sistema ANPR de Control de Ingreso Vehicular" />

          <form className="auth-form" onSubmit={enviarLogin} noValidate>
            {errorEstado && <Aviso tipo="error">No se pudo contactar con el servidor. Verifique la conexión de red.</Aviso>}
            {motivoCierre && !errorLogin && <Aviso tipo="advertencia">{motivoCierre}</Aviso>}
            {errorLogin && <Aviso tipo="error">{errorLogin}</Aviso>}

            <Campo id="login-email" etiqueta="Correo electrónico institucional*" type="email" name="email" maxLength={150}
              placeholder={ejemploCorreo} value={email} onChange={e => setEmail(e.target.value)} disabled={cargandoLogin}
              autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              icono={<Mail size={20} />} autoFocus={modo === 'login'} />

            <CampoPassword id="login-password" etiqueta="Contraseña*" placeholder="••••••••••" value={password}
              onChange={e => setPassword(e.target.value)} disabled={cargandoLogin} autoComplete="current-password" maxLength={128} />

            <div style={{ marginTop: -6 }}>
              <button type="button" className="auth-enlace" onClick={() => setOlvideAbierto(true)}>¿Olvidó su contraseña?</button>
            </div>

            {sinVerificar && (
              <Aviso tipo="advertencia">
                <p>La cuenta <strong>{sinVerificar}</strong> aún no verificó su correo. Abra el enlace que le enviamos para activarla.</p>
                <div style={{ marginTop: 10 }}>
                  <Boton type="button" secundario cargando={reenviando} textoCargando="Reenviando enlace…"
                    onClick={() => reenviarVerificacion(sinVerificar)}>Reenviar enlace de verificación</Boton>
                </div>
                {mensajeReenvio && <p style={{ marginTop: 8 }}>{mensajeReenvio}</p>}
              </Aviso>
            )}

            <Boton type="submit" cargando={cargandoLogin} textoCargando="Verificando credenciales…">Acceder</Boton>
          </form>

          <UsoExclusivo />

          {estado?.registro_habilitado !== false && (
            <div className="auth-pie">
              ¿No tiene una cuenta?{' '}
              <button type="button" className="auth-enlace rojo" onClick={() => cambiarModo('registro')}>Registrarse</button>
            </div>
          )}
        </div>
      </section>

      {/* ── REGISTRO (mitad derecha) ── */}
      <section className={`auth-lado derecha ${modo === 'registro' ? 'visible' : 'oculto'}`} aria-hidden={modo !== 'registro'}>
        <div className="auth-caja ancha">
          <button type="button" className="auth-volver" onClick={() => { setRegistrado(null); cambiarModo('login'); }}>
            <ArrowLeft size={16} /> Volver al inicio de sesión
          </button>

          {registrado ? (
            <div style={{ textAlign: 'center' }}>
              <div className="auth-icono-estado rojo"><Mail size={34} /></div>
              <div className="auth-encabezado" style={{ marginBottom: 16 }}>
                <h1>Verifique su correo</h1>
                <p>Enviamos un enlace de activación a:</p>
              </div>
              <div className="auth-correo-destacado" style={{ marginBottom: 18 }}>{registrado.email}</div>
              <div style={{ textAlign: 'left', display: 'grid', gap: 12 }}>
                <Aviso tipo="advertencia">
                  <strong>Paso obligatorio:</strong> abra el mensaje y presione <strong>“Verificar mi correo”</strong>.
                  El enlace vence en 24 horas. Al verificarlo, su cuenta queda activa con el rol <strong>Guardia</strong>.
                </Aviso>
                {mensajeReenvio && <Aviso tipo="info">{mensajeReenvio}</Aviso>}
                <Boton type="button" onClick={() => { setRegistrado(null); cambiarModo('login'); }}>Ir a iniciar sesión</Boton>
                <Boton type="button" secundario cargando={reenviando} textoCargando="Reenviando…"
                  onClick={() => reenviarVerificacion(registrado.email)}>¿No llegó el correo? Reenviar enlace</Boton>
              </div>
            </div>
          ) : (
            <>
              <Encabezado logoGrande={false} titulo="Registrar cuenta" subtitulo="Personal autorizado del ECU 911" />
              <form className="auth-form compacto" onSubmit={enviarRegistro} noValidate>
                {errorRegistro && <Aviso tipo="error">{errorRegistro}</Aviso>}

                <Campo id="reg-nombre" etiqueta="Nombres y apellidos completos*" placeholder="Nombres y apellidos"
                  value={reg.nombre} onChange={campoReg('nombre', v => filtrarTexto(v, 'nombre'))} onBlur={tocar('nombre')}
                  disabled={cargandoRegistro} autoComplete="name" maxLength={REGLAS_USUARIO.nombre_completo.max} aria-required
                  icono={<User size={20} />} error={tocado('nombre') ? erroresRegistro.nombre : null} />

                <Campo id="reg-cargo" etiqueta="Cargo (opcional)" placeholder="Ej.: Agente de seguridad, Guardia de garita"
                  value={reg.cargo} onChange={campoReg('cargo', v => filtrarTexto(v, 'alfanumerico'))} onBlur={tocar('cargo')}
                  disabled={cargandoRegistro} maxLength={REGLAS_USUARIO.cargo.max} autoComplete="organization-title"
                  icono={<Briefcase size={20} />} error={tocado('cargo') ? erroresRegistro.cargo : null} />

                <Campo id="reg-email" etiqueta="Correo electrónico institucional*" type="email" placeholder={ejemploCorreo}
                  value={reg.email} onChange={campoReg('email', v => v.replace(/\s/g, ''))} onBlur={tocar('email')}
                  disabled={cargandoRegistro} maxLength={150} aria-required
                  autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  icono={<Mail size={20} />} error={tocado('email') ? errorCorreoRegistro : null}
                  exito={reg.email && !errorCorreoRegistro ? 'Correo con dominio autorizado' : null} />

                <ParPassword prefijo="reg" password={reg.password} confirmar={reg.confirmar} deshabilitado={cargandoRegistro}
                  onPassword={v => setReg(r => ({ ...r, password: v }))} onConfirmar={v => setReg(r => ({ ...r, confirmar: v }))} />

                <Declaracion marcado={declaracion} onChange={setDeclaracion} deshabilitado={cargandoRegistro}
                  titulo="Declaro ser personal autorizado del ECU 911"
                  texto="Acepto que mis inicios de sesión, validaciones y cambios en el sistema quedan registrados en la auditoría institucional." />

                <Aviso tipo="info">
                  Recibirá un correo para verificar su dirección. Tras verificarla, su cuenta queda activa con el rol
                  <strong> Guardia</strong>; un administrador puede asignarle otro rol.
                </Aviso>

                <Boton type="submit" disabled={!puedeRegistrar} cargando={cargandoRegistro} textoCargando="Creando cuenta…">Crear cuenta</Boton>

                <p style={{ textAlign: 'center', fontSize: 12, color: '#64748b' }}>
                  ¿Ya tiene una cuenta?{' '}
                  <button type="button" className="auth-enlace rojo" style={{ fontSize: 12 }} onClick={() => cambiarModo('login')}>Inicie sesión</button>
                </p>
              </form>
            </>
          )}
        </div>
      </section>

      {olvideAbierto && <OlvidePasswordModal emailInicial={email} dominios={dominios} onCerrar={() => setOlvideAbierto(false)} />}
    </div>
  );
};

export default Acceso;
