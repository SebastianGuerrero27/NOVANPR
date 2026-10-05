import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info, Loader2, Lock, ScanLine, ShieldCheck, History, AlertTriangle, Check } from 'lucide-react';
import api from '../../../infraestructura/api';
import { REGLAS_PASSWORD, passwordValida } from '../../../dominio/password';
import { errorCorreoInstitucional } from '../../../dominio/validacion';
import logoEcu911 from '../../../assets/ecu911.png';
import fondoLogin from '../../../assets/fondo-login.webp';
import './auth.css';

/* ─── Estado público del sistema (GET /api/auth/estado) ─── */

export interface EstadoSistema {
  configuracion_inicial_requerida: boolean;
  registro_habilitado: boolean;
  smtp_configurado: boolean;
  dominios_permitidos: string[];
  unidad_institucional: string;
}

let estadoEnCurso: Promise<EstadoSistema> | null = null;

export function obtenerEstadoSistema(forzar = false): Promise<EstadoSistema> {
  if (!estadoEnCurso || forzar) {
    estadoEnCurso = api.get<EstadoSistema>('/auth/estado').then(r => r.data).catch(e => {
      estadoEnCurso = null;
      throw e;
    });
  }
  return estadoEnCurso;
}

export function useEstadoSistema() {
  const [estado, setEstado] = useState<EstadoSistema | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let vivo = true;
    obtenerEstadoSistema(true)
      .then(e => vivo && setEstado(e))
      .catch(() => vivo && setError(true));
    return () => { vivo = false; };
  }, []);
  return { estado, error };
}

/* ─── Validaciones (las de la API: lib/password.ts y lib/validacion.ts) ─── */

export { REGLAS_PASSWORD, passwordValida };

/** Formato y dominio institucional del correo; vacío = sin error (lo exige el botón de envío). */
export function errorEmail(email: string, dominios: readonly string[] | undefined): string | null {
  return email.trim() ? errorCorreoInstitucional(email, dominios) : null;
}

/** Campos que la persona ya dejó: su error se muestra al salir del campo, no mientras escribe. */
export function useTocados<K extends string>() {
  const [tocados, setTocados] = useState<Partial<Record<K, boolean>>>({});
  return {
    tocado: (k: K) => Boolean(tocados[k]),
    tocar: (k: K) => () => setTocados(t => (t[k] ? t : { ...t, [k]: true })),
    reiniciar: () => setTocados({}),
  };
}

/* ─── Estructura de pantalla ─── */

export const PanelImagen: React.FC = () => {
  const [unidad, setUnidad] = useState<string | null>(null);
  useEffect(() => { obtenerEstadoSistema().then(e => setUnidad(e.unidad_institucional)).catch(() => undefined); }, []);
  return (
  <div className="auth-imagen" aria-hidden="true">
    <img src={fondoLogin} alt="" decoding="async" />
    <div className="auth-imagen-velo" />
    <div className="auth-imagen-texto">
      <div className="etiqueta" style={{ visibility: unidad ? 'visible' : 'hidden' }}><ScanLine size={14} /> {unidad ?? '·'}</div>
      <h2>Control de ingreso vehicular por reconocimiento de placas</h2>
      <p>Plataforma ANPR del Servicio Integrado de Seguridad ECU 911 para el registro, verificación y
        trazabilidad de cada vehículo que ingresa a las instalaciones.</p>
      <ul>
        <li><ScanLine size={16} /> Lectura automática de placas ecuatorianas</li>
        <li><ShieldCheck size={16} /> Verificación contra la lista blanca y la lista negra</li>
        <li><History size={16} /> Historial y auditoría de cada acceso y validación</li>
      </ul>
    </div>
  </div>
  );
};

/** Pantalla con la imagen a la izquierda y un único formulario a la derecha. */
export const PantallaSimple: React.FC<{ children: React.ReactNode; ancha?: boolean }> = ({ children, ancha }) => (
  <div className="auth-root" data-lado="izquierda">
    <PanelImagen />
    <div className="auth-lado derecha visible">
      <div className={`auth-caja${ancha ? ' ancha' : ''}`}>{children}</div>
    </div>
  </div>
);

export const Encabezado: React.FC<{ titulo: string; subtitulo?: string; sobre?: string; logoGrande?: boolean }> = ({ titulo, subtitulo, sobre, logoGrande = true }) => (
  <>
    <div className="auth-logo">
      <img src={logoEcu911} alt="Servicio Integrado de Seguridad ECU 911" style={logoGrande ? undefined : { height: 58 }} />
    </div>
    <div className="auth-encabezado">
      {sobre && <div className="sobre">{sobre}</div>}
      <h1>{titulo}</h1>
      {subtitulo && <p>{subtitulo}</p>}
    </div>
  </>
);

/* ─── Campos ─── */

interface CampoProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  etiqueta: string;
  icono?: React.ReactNode;
  error?: string | null;
  exito?: string | null;
}

export const Campo: React.FC<CampoProps> = ({ id, etiqueta, icono, error, exito, ...input }) => (
  <div>
    <div className={`auth-campo-marco${error ? ' error' : ''}`}>
      <label htmlFor={id}>{etiqueta}</label>
      <div className="auth-campo-fila">
        <input id={id} aria-invalid={!!error} aria-describedby={error || exito ? `${id}-ayuda` : undefined} {...input} />
        {icono}
      </div>
    </div>
    {error && <p id={`${id}-ayuda`} className="auth-ayuda error"><AlertCircle size={12} /> {error}</p>}
    {!error && exito && <p id={`${id}-ayuda`} className="auth-ayuda ok"><CheckCircle2 size={12} /> {exito}</p>}
  </div>
);

export const CampoPassword: React.FC<Omit<CampoProps, 'icono' | 'type'>> = (props) => {
  const [visible, setVisible] = useState(false);
  return (
    <Campo
      {...props}
      type={visible ? 'text' : 'password'}
      icono={
        <button type="button" className="auth-ojo" onClick={() => setVisible(v => !v)}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} title={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
          {visible ? <EyeOff size={20} /> : <Eye size={20} />}
        </button>
      }
    />
  );
};

export const FortalezaPassword: React.FC<{ password: string }> = ({ password }) => {
  if (!password) return null;
  const cumplidas = REGLAS_PASSWORD.filter(r => r.ok(password)).length;
  const color = cumplidas <= 2 ? '#ef4444' : cumplidas <= 4 ? '#f59e0b' : '#059669';
  return (
    <div className="auth-fuerza" aria-live="polite">
      <div className="auth-fuerza-barras">
        {REGLAS_PASSWORD.map((_, i) => <span key={i} style={i < cumplidas ? { background: color } : undefined} />)}
      </div>
      <div className="auth-fuerza-reglas">
        {REGLAS_PASSWORD.map(r => (
          <div key={r.texto} className={r.ok(password) ? 'cumple' : ''}>
            {r.ok(password) ? <CheckCircle2 size={11} /> : <Lock size={11} />} {r.texto}
          </div>
        ))}
      </div>
    </div>
  );
};

/** Contraseña + confirmación con indicador de fortaleza. */
export const ParPassword: React.FC<{
  password: string; confirmar: string; deshabilitado?: boolean; prefijo: string;
  onPassword: (v: string) => void; onConfirmar: (v: string) => void; etiqueta?: string;
}> = ({ password, confirmar, deshabilitado, prefijo, onPassword, onConfirmar, etiqueta = 'Contraseña*' }) => (
  <>
    <div>
      <CampoPassword id={`${prefijo}-pass`} etiqueta={etiqueta} placeholder="Mínimo 10 caracteres" value={password}
        onChange={e => onPassword(e.target.value)} disabled={deshabilitado} autoComplete="new-password" maxLength={128} />
      <FortalezaPassword password={password} />
    </div>
    <CampoPassword id={`${prefijo}-conf`} etiqueta="Confirmar contraseña*" placeholder="Repita la contraseña" value={confirmar}
      onChange={e => onConfirmar(e.target.value)} disabled={deshabilitado} autoComplete="new-password" maxLength={128}
      error={confirmar && confirmar !== password ? 'Las contraseñas no coinciden' : null}
      exito={confirmar && confirmar === password ? 'Las contraseñas coinciden' : null} />
  </>
);

/* ─── Avisos y botones ─── */

const ICONOS_AVISO = { info: Info, error: AlertCircle, exito: CheckCircle2, advertencia: AlertTriangle };

export const Aviso: React.FC<{ tipo?: keyof typeof ICONOS_AVISO; children: React.ReactNode }> = ({ tipo = 'info', children }) => {
  const Icono = ICONOS_AVISO[tipo];
  return (
    <div className={`auth-aviso ${tipo}`} role={tipo === 'error' ? 'alert' : 'status'}>
      <Icono size={16} />
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
};

export const Boton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { cargando?: boolean; textoCargando?: string; secundario?: boolean }> =
  ({ cargando, textoCargando, secundario, children, disabled, className, ...resto }) => (
    <button className={`auth-boton${secundario ? ' secundario' : ''}${className ? ' ' + className : ''}`} disabled={disabled || cargando} {...resto}>
      {cargando ? <><Loader2 size={18} className="auth-girar" /> {textoCargando ?? 'Procesando…'}</> : children}
    </button>
  );

export const Declaracion: React.FC<{ marcado: boolean; onChange: (v: boolean) => void; titulo: string; texto: string; deshabilitado?: boolean }> =
  ({ marcado, onChange, titulo, texto, deshabilitado }) => (
    <label className={`auth-check${marcado ? ' marcado' : ''}`}>
      <input type="checkbox" checked={marcado} onChange={e => onChange(e.target.checked)} disabled={deshabilitado} />
      <span className="auth-check-caja">{marcado && <Check size={13} strokeWidth={3} />}</span>
      <span><strong>{titulo}</strong><span className="texto">{texto}</span></span>
    </label>
  );

export const PantallaCarga: React.FC<{ texto?: string }> = ({ texto = 'CARGANDO…' }) => (
  <div className="auth-pantalla-carga">
    <Loader2 size={30} className="auth-girar" color="#b91c1c" />
    {texto}
  </div>
);

export const UsoExclusivo: React.FC = () => (
  <div className="auth-exclusivo">
    <span className="i">i</span>
    <p>Sistema de uso exclusivo para el personal autorizado del ECU 911. Cada acceso queda registrado con fecha, hora y dirección IP.</p>
  </div>
);
