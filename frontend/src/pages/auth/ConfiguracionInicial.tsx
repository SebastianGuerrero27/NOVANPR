import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Briefcase, Mail, ShieldCheck, User } from 'lucide-react';
import api, { mensajeError } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import {
  Aviso, Boton, Campo, Encabezado, PantallaCarga, PantallaSimple, ParPassword,
  errorEmail, obtenerEstadoSistema, passwordValida, useEstadoSistema,
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
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/" replace />;
  if (!estado && !errorEstado) return <PantallaCarga texto="CONECTANDO CON EL SISTEMA…" />;
  if (estado && !estado.configuracion_inicial_requerida) return <Navigate to="/login" replace />;

  const errorCorreo = errorEmail(f.email, estado?.dominios_permitidos);
  const valido = f.nombre.trim().length >= 5 && !!f.email && !errorCorreo && passwordValida(f.password) && f.password === f.confirmar;
  const campo = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF(v => ({ ...v, [k]: e.target.value }));

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

        <Campo id="ini-nombre" etiqueta="Nombres y apellidos completos*" value={f.nombre} onChange={campo('nombre')}
          disabled={enviando} autoComplete="name" maxLength={150} icono={<User size={20} />}
          error={f.nombre && f.nombre.trim().length < 5 ? 'Mínimo 5 caracteres' : null} autoFocus />
        <Campo id="ini-cargo" etiqueta="Cargo (opcional)" placeholder="Ej.: Coordinador de tecnología" value={f.cargo}
          onChange={campo('cargo')} disabled={enviando} maxLength={100} icono={<Briefcase size={20} />} />
        <Campo id="ini-email" etiqueta="Correo electrónico institucional*" type="email" value={f.email}
          placeholder={`admin@${estado?.dominios_permitidos?.[0] ?? 'ecu911.gob.ec'}`} onChange={campo('email')}
          disabled={enviando} maxLength={150} autoComplete="username" autoCapitalize="none" spellCheck={false}
          icono={<Mail size={20} />} error={errorCorreo} />
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
