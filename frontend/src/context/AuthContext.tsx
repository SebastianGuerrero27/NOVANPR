import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import api, { EVENTO_SESION_EXPIRADA, guardarToken, leerToken } from '../services/api';
import type { Permiso, Rol } from '../lib/permisos';
import { desvincularPush } from '../lib/push';

export type { Permiso, Rol };

export interface User {
  id: number;
  email: string;
  username: string; // = email (compatibilidad con componentes existentes)
  nombre: string;
  cargo?: string | null;
  rol: Rol;
  rol_nombre?: string;
  /** Permisos del rol entregados por el backend (fuente de verdad de la matriz RBAC) */
  permisos?: Permiso[];
  fecha_ultimo_acceso?: string | null;
  fecha_creacion?: string;
}

/** Error de inicio de sesión con el código del backend (p. ej. EMAIL_NO_VERIFICADO). */
export class ErrorAcceso extends Error {
  constructor(message: string, public codigo?: string, public status?: number) {
    super(message);
  }
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  /** Instante (ms) en que vence la sesión actual */
  expira: number | null;
  /** Motivo del último cierre de sesión forzado, para mostrarlo en el login */
  motivoCierre: string | null;
  login: (email: string, password: string) => Promise<User>;
  /** Abre sesión con una respuesta { token, user } ya obtenida (configuración inicial) */
  establecerSesion: (token: string, user: User) => void;
  logout: (motivo?: string) => void;
  refrescarUsuario: () => Promise<void>;
  tieneRol: (...roles: Rol[]) => boolean;
  /** ¿La sesión tiene TODOS los permisos indicados? */
  puede: (...permisos: Permiso[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Segundos epoch de expiración del JWT (sin validar firma: eso lo hace el backend). */
function expiracionToken(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [motivoCierre, setMotivoCierre] = useState<string | null>(null);
  const [expira, setExpira] = useState<number | null>(null);
  const temporizador = useRef<number | undefined>(undefined);

  const logout = useCallback((motivo?: string) => {
    window.clearTimeout(temporizador.current);
    // Puesto compartido: este navegador deja de recibir los push de la cuenta que sale
    void desvincularPush(leerToken());
    guardarToken(null);
    setToken(null);
    setUser(null);
    setExpira(null);
    setMotivoCierre(motivo ?? null);
  }, []);

  // Cierre automático exactamente cuando vence el JWT
  const programarExpiracion = useCallback((t: string) => {
    window.clearTimeout(temporizador.current);
    const exp = expiracionToken(t);
    setExpira(exp ? exp * 1000 : null);
    if (!exp) return;
    const ms = exp * 1000 - Date.now();
    if (ms <= 0) { logout('Su sesión expiró. Inicie sesión nuevamente.'); return; }
    // setTimeout admite hasta ~24,8 días; las sesiones duran horas
    temporizador.current = window.setTimeout(
      () => logout('Su sesión expiró. Inicie sesión nuevamente.'),
      Math.min(ms, 2_147_000_000),
    );
  }, [logout]);

  const establecerSesion = useCallback((t: string, u: User) => {
    guardarToken(t);
    setToken(t);
    setUser(u);
    setMotivoCierre(null);
    programarExpiracion(t);
  }, [programarExpiracion]);

  useEffect(() => {
    const inicial = leerToken();
    if (!inicial) { setLoading(false); return; }
    setToken(inicial);
    api.get('/auth/me')
      .then(res => { setUser(res.data.user); programarExpiracion(inicial); })
      .catch(() => logout())
      .finally(() => setLoading(false));
  }, [logout, programarExpiracion]);

  useEffect(() => {
    const alExpirar = () => logout('Su sesión expiró o fue revocada. Inicie sesión nuevamente.');
    window.addEventListener(EVENTO_SESION_EXPIRADA, alExpirar);
    return () => {
      window.removeEventListener(EVENTO_SESION_EXPIRADA, alExpirar);
      window.clearTimeout(temporizador.current);
    };
  }, [logout]);

  const login = async (email: string, password: string): Promise<User> => {
    try {
      const res = await api.post('/auth/login', { email: email.trim().toLowerCase(), password });
      establecerSesion(res.data.token, res.data.user);
      return res.data.user;
    } catch (error: any) {
      const d = error.response?.data;
      throw new ErrorAcceso(
        d?.error || (error.response ? 'Error al iniciar sesión.' : 'Sin conexión con el servidor.'),
        d?.codigo,
        error.response?.status,
      );
    }
  };

  const refrescarUsuario = async () => {
    const res = await api.get('/auth/me');
    setUser(res.data.user);
  };

  const tieneRol = (...roles: Rol[]) => !!user && roles.includes(user.rol);
  const puede = useCallback((...permisos: Permiso[]) => !!user?.permisos && permisos.every(p => user.permisos!.includes(p)), [user]);

  return (
    <AuthContext.Provider value={{ user, token, loading, expira, motivoCierre, login, establecerSesion, logout, refrescarUsuario, tieneRol, puede }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth debe ser usado dentro de un AuthProvider');
  }
  return context;
};
