import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Briefcase, Mail, ShieldCheck, User } from 'lucide-react';
import api, { mensajeError } from '../../../infraestructura/api';
import { useAuth } from '../../../aplicacion/AuthContext';
import { errorCorreoInstitucional, errorDe, filtrarTexto, sinErrores, validarTexto } from '../../../dominio/validacion';
import { REGLAS_USUARIO } from '../../../dominio/reglas';
import { filtrarEscrito } from '../../componentes/campos';
import {
  Aviso, Boton, Campo, Encabezado, PantallaCarga, PantallaSimple, ParPassword,
  obtenerEstadoSistema, passwordValida, useEstadoSistema, useTocados,
} from './componentes';

/**
 * Primer arranque: crea el administrador principal. El backend solo acepta esta
 * solicitud mientras no exista ningún administrador (transacción serializable), así
 * que la pantalla deja de estar disponible en cuanto se completa.
 */
const ConfiguracionInicial: React.FC = () => {
  const { user, establecerSesion } = useAuth();
  const { estado, error: errorEstado } = useEstadoSistema();
  const navigate = useNavigate();
  const [f, setF] = useState({ nombre: '', cargo: '', email: '', password: '', confirmar: '' });
  const { tocado, tocar } = useTocados<'nombre' | 'cargo' | 'email'>();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/" replace />;
  if (!estado && !errorEstado) return <PantallaCarga texto="CONECTANDO CON EL SISTEMA…" />;
  if (estado && !estado.configuracion_inicial_requerida) return <Navigate to="/login" replace />;

  // Mismas reglas que la API (dominio/usuarios.ts → leerRegistro)
  const errores = {
    nombre: errorDe(validarTexto(f.nombre, REGLAS_USUARIO.nombre_completo)),
    cargo: errorDe(validarTexto(f.cargo, REGLAS_USUARIO.cargo)),
    email: errorCorreoInstitucional(f.email, estado?.dominios_permitidos),
  };
  const errorCorreo = errores.email;
  const valido = sinErrores(errores) && passwordValida(f.password) && f.password === f.confirmar;
  /** Cambio de un campo; con `limpiar`, los caracteres no admitidos no llegan a escribirse. */
  const campo = (k: keyof typeof f, limpiar?: (v: string) => string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const valor = limpiar ? filtrarEscrito(e.target, limpiar) : e.target.value;
    setF(v => ({ ...v, [k]: valor }));
  };

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valido) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post('/auth/configuracion-inicial', {
        nombre_completo: f.nombre.trim(), cargo: f.cargo.trim() || undefined,
        email: f.email.trim().toLowerCase(), password: f.password,
      });
      await obtenerEstadoSistema(true).catch(() => undefined);
      establecerSesion(r.data.token, r.data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(mensajeError(err, 'No se pudo crear el administrador.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <PantallaSimple ancha>
      <Encabezado logoGrande={false} sobre="Primer arranque del sistema" titulo="Configuración inicial"
        subtitulo="Cree la cuenta del administrador principal" />

      <form className="auth-form compacto" onSubmit={enviar} noValidate>
        {errorEstado && <Aviso tipo="error">No se pudo contactar con el servidor. Verifique que el backend esté en ejecución.</Aviso>}
        <Aviso tipo="info">
          <strong>El sistema no tiene administradores.</strong> Esta cuenta tendrá control total: usuarios, cámaras,
          listas y configuración. La pantalla se desactiva en cuanto se crea.
        </Aviso>
        {error && <Aviso tipo="error">{error}</Aviso>}

        <Campo id="ini-nombre" etiqueta="Nombres y apellidos completos*" value={f.nombre} onChange={campo('nombre', v => filtrarTexto(v, 'nombre'))}
          onBlur={tocar('nombre')} disabled={enviando} autoComplete="name" maxLength={REGLAS_USUARIO.nombre_completo.max} aria-required
          icono={<User size={20} />} error={tocado('nombre') ? errores.nombre : null} autoFocus />
        <Campo id="ini-cargo" etiqueta="Cargo (opcional)" placeholder="Ej.: Coordinador de tecnología" value={f.cargo}
          onChange={campo('cargo', v => filtrarTexto(v, 'alfanumerico'))} onBlur={tocar('cargo')} disabled={enviando}
          maxLength={REGLAS_USUARIO.cargo.max} icono={<Briefcase size={20} />} error={tocado('cargo') ? errores.cargo : null} />
        <Campo id="ini-email" etiqueta="Correo electrónico institucional*" type="email" value={f.email}
          placeholder={`admin@${estado?.dominios_permitidos?.[0] ?? 'ecu911.gob.ec'}`} onChange={campo('email', v => v.replace(/\s/g, ''))}
          onBlur={tocar('email')} disabled={enviando} maxLength={150} autoComplete="username" autoCapitalize="none" spellCheck={false}
          aria-required icono={<Mail size={20} />} error={tocado('email') ? errorCorreo : null} />
        <ParPassword prefijo="ini" password={f.password} confirmar={f.confirmar} deshabilitado={enviando}
          onPassword={v => setF(x => ({ ...x, password: v }))} onConfirmar={v => setF(x => ({ ...x, confirmar: v }))} />

        <Boton type="submit" disabled={!valido} cargando={enviando} textoCargando="Creando administrador…">
          <ShieldCheck size={18} /> Crear administrador e ingresar
        </Boton>
      </form>
    </PantallaSimple>
  );
};

export default ConfiguracionInicial;
