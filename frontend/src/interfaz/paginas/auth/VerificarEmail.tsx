import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, Mail, XCircle } from 'lucide-react';
import api, { mensajeError } from '../../../infraestructura/api';
import { Aviso, Boton, Campo, Encabezado, PantallaSimple } from './componentes';

/** Destino del enlace del correo de activación: /verificar-email?token=… */
const VerificarEmail: React.FC = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [estado, setEstado] = useState<'verificando' | 'exito' | 'error'>('verificando');
  const [mensaje, setMensaje] = useState('');
  const [expirado, setExpirado] = useState(false);
  const [email, setEmail] = useState('');
  const [reenvio, setReenvio] = useState<string | null>(null);
  const [reenviando, setReenviando] = useState(false);
  const solicitado = useRef(false);

  useEffect(() => {
    // El token es de un solo uso: evitar la doble llamada de StrictMode en desarrollo
    if (solicitado.current) return;
    solicitado.current = true;
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setEstado('error');
      setMensaje('El enlace de verificación está incompleto o no es válido.');
      return;
    }
    api.get('/auth/verificar-email', { params: { token } })
      .then(r => { setEstado('exito'); setMensaje(r.data.message); })
      .catch(err => {
        setEstado('error');
        setExpirado(err?.response?.data?.codigo === 'TOKEN_EXPIRADO');
        setMensaje(mensajeError(err, 'No se pudo verificar el correo.'));
      });
  }, [token]);

  const reenviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setReenviando(true);
    try {
      const r = await api.post('/auth/reenviar-verificacion', { email: email.trim().toLowerCase() });
      setReenvio(r.data.message);
    } catch (err) {
      setReenvio(mensajeError(err));
    } finally {
      setReenviando(false);
    }
  };

  return (
    <PantallaSimple>
      <Encabezado logoGrande={false} sobre="Activación de cuenta" titulo="Verificación de correo" />
      <div style={{ textAlign: 'center' }}>
        {estado === 'verificando' && (
          <>
            <div className="auth-icono-estado gris"><Loader2 size={32} className="auth-girar" /></div>
            <p style={{ fontSize: 14, color: '#475569' }}>Verificando su enlace…</p>
          </>
        )}
        {estado === 'exito' && (
          <>
            <div className="auth-icono-estado verde"><CheckCircle2 size={34} /></div>
            <div style={{ display: 'grid', gap: 16, textAlign: 'left' }}>
              <Aviso tipo="exito">{mensaje}</Aviso>
              <Boton type="button" onClick={() => navigate("/login", { replace: true })}>Iniciar sesión</Boton>
            </div>
          </>
        )}
        {estado === 'error' && (
          <>
            <div className="auth-icono-estado rojo"><XCircle size={34} /></div>
            <div style={{ display: 'grid', gap: 16, textAlign: 'left' }}>
              <Aviso tipo="error">{mensaje}</Aviso>
              {expirado && (
                reenvio ? <Aviso tipo="info">{reenvio}</Aviso> : (
                  <form className="auth-form compacto" onSubmit={reenviar} noValidate>
                    <p style={{ fontSize: 13, color: '#475569' }}>Solicite un nuevo enlace con el correo de su cuenta:</p>
                    <Campo id="ver-email" etiqueta="Correo electrónico*" type="email" value={email} maxLength={150}
                      onChange={e => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} icono={<Mail size={20} />} />
                    <Boton type="submit" disabled={!email.trim()} cargando={reenviando} textoCargando="Enviando…">Enviar nuevo enlace</Boton>
                  </form>
                )
              )}
              <Link to="/login" className="auth-enlace" style={{ textAlign: 'center' }}>Volver al inicio de sesión</Link>
            </div>
          </>
        )}
      </div>
    </PantallaSimple>
  );
};

export default VerificarEmail;
