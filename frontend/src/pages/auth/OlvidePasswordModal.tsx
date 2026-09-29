import React, { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import api, { mensajeError } from '../../services/api';
import logoEcu911 from '../../assets/ecu911.png';
import { Aviso, Boton, Campo, errorEmail } from './componentes';

/** Solicitud de enlace de restablecimiento. La respuesta del backend es siempre genérica. */
const OlvidePasswordModal: React.FC<{ emailInicial?: string; dominios?: string[]; onCerrar: () => void }> = ({ emailInicial = '', dominios, onCerrar }) => {
  const [email, setEmail] = useState(emailInicial);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ tipo: 'exito' | 'error'; texto: string } | null>(null);

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => { if (e.key === 'Escape' && !enviando) onCerrar(); };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [enviando, onCerrar]);

  const errorCorreo = errorEmail(email, dominios);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || errorCorreo) return;
    setEnviando(true);
    setResultado(null);
    try {
      const r = await api.post('/auth/olvide-password', { email: email.trim().toLowerCase() });
      setResultado({ tipo: 'exito', texto: r.data.message });
    } catch (err) {
      setResultado({ tipo: 'error', texto: mensajeError(err) });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="auth-modal-fondo" onMouseDown={e => { if (e.target === e.currentTarget && !enviando) onCerrar(); }}>
      <div className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="olvide-titulo">
        <div className="auth-logo" style={{ marginBottom: 12 }}><img src={logoEcu911} alt="ECU 911" style={{ height: 48 }} /></div>
        <h3 id="olvide-titulo">Recuperar contraseña</h3>
        <p className="desc">Ingrese su correo institucional. Si pertenece a una cuenta activa, recibirá un enlace válido por 30 minutos.</p>

        {resultado ? (
          <>
            <Aviso tipo={resultado.tipo}>{resultado.texto}</Aviso>
            <div className="auth-modal-acciones">
              <Boton type="button" onClick={onCerrar}>Entendido</Boton>
            </div>
          </>
        ) : (
          <form onSubmit={enviar} noValidate>
            <Campo id="olvide-email" etiqueta="Correo institucional*" type="email" value={email} maxLength={150}
              onChange={e => setEmail(e.target.value)} disabled={enviando} autoFocus autoCapitalize="none" autoCorrect="off"
              spellCheck={false} autoComplete="username" icono={<Mail size={20} />} error={errorCorreo} />
            <div className="auth-modal-acciones">
              <Boton type="button" secundario onClick={onCerrar} disabled={enviando}>Cancelar</Boton>
              <Boton type="submit" disabled={!email.trim() || !!errorCorreo} cargando={enviando} textoCargando="Enviando…">Enviar enlace</Boton>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default OlvidePasswordModal;
