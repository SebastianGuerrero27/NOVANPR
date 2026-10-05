import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, KeyRound } from 'lucide-react';
import api, { mensajeError } from '../../../infraestructura/api';
import { Aviso, Boton, Encabezado, PantallaSimple, ParPassword, passwordValida } from './componentes';

/**
 * Destino de los enlaces /restablecer-password?token=… : recuperación de contraseña y
 * definición de la primera contraseña en cuentas creadas por un administrador.
 */
const RestablecerPassword: React.FC = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const tokenValido = /^[a-f0-9]{64}$/.test(token);
  const [password, setPassword] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<string | null>(null);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordValida(password) || password !== confirmar) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post('/auth/restablecer-password', { token, password });
      setListo(r.data.message);
      setPassword('');
      setConfirmar('');
    } catch (err) {
      setError(mensajeError(err, 'No se pudo actualizar la contraseña.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <PantallaSimple>
      <Encabezado logoGrande={false} sobre="Seguridad de la cuenta" titulo="Definir contraseña"
        subtitulo="Establezca una contraseña nueva para su cuenta" />

      {listo ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="auth-icono-estado verde"><CheckCircle2 size={34} /></div>
          <Aviso tipo="exito">{listo}</Aviso>
          <Boton type="button" onClick={() => navigate("/login", { replace: true })}>Iniciar sesión</Boton>
        </div>
      ) : !tokenValido ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <Aviso tipo="error">El enlace está incompleto o no es válido. Solicite uno nuevo desde “¿Olvidó su contraseña?”.</Aviso>
          <Link to="/login" className="auth-enlace" style={{ textAlign: 'center' }}>Volver al inicio de sesión</Link>
        </div>
      ) : (
        <form className="auth-form compacto" onSubmit={enviar} noValidate>
          {error && <Aviso tipo="error">{error}</Aviso>}
          <ParPassword prefijo="rest" etiqueta="Nueva contraseña*" password={password} confirmar={confirmar}
            deshabilitado={enviando} onPassword={setPassword} onConfirmar={setConfirmar} />
          <Aviso tipo="info">El enlace es de un solo uso. Al guardar, recibirá un correo confirmando el cambio.</Aviso>
          <Boton type="submit" disabled={!passwordValida(password) || password !== confirmar} cargando={enviando} textoCargando="Guardando…">
            <KeyRound size={18} /> Guardar contraseña
          </Boton>
          <Link to="/login" className="auth-enlace" style={{ textAlign: 'center' }}>Volver al inicio de sesión</Link>
        </form>
      )}
    </PantallaSimple>
  );
};

export default RestablecerPassword;
