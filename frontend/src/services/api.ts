import axios from 'axios';

// La URL apunta al backend expuesto en localhost para el navegador del cliente.
// VITE_API_URL vacío (imagen de producción tras un Ingress) = la API está en el mismo origen.
// Normalizar para evitar que VITE_API_URL incluya el sufijo '/api' accidentalmente
// y luego añadir el prefijo real de la API una sola vez.
const URL_CONFIGURADA = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';
let API_URL = URL_CONFIGURADA.trim() || window.location.origin;
API_URL = API_URL.replace(/\/api\/?$/, '');

// La sesión vive en sessionStorage: se cierra al cerrar el navegador del puesto de guardia.
export const CLAVE_TOKEN = 'anpr_token';
export const EVENTO_SESION_EXPIRADA = 'anpr:sesion-expirada';

export const leerToken = (): string | null => {
  try { return sessionStorage.getItem(CLAVE_TOKEN); } catch { return null; }
};
export const guardarToken = (token: string | null) => {
  try {
    if (token) sessionStorage.setItem(CLAVE_TOKEN, token);
    else sessionStorage.removeItem(CLAVE_TOKEN);
  } catch { /* almacenamiento no disponible */ }
};

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para inyectar automáticamente el token JWT
api.interceptors.request.use((config) => {
  const token = leerToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Un 401 en una ruta protegida significa sesión expirada o revocada: se avisa al AuthContext.
// Las rutas públicas de autenticación devuelven 401 por credenciales y no deben cerrar nada.
api.interceptors.response.use(
  (r) => r,
  (error) => {
    const url: string = error.config?.url ?? '';
    const esRutaPublica = /\/auth\/(login|registro|configuracion-inicial|olvide-password|restablecer-password|verificar-email|reenviar-verificacion|estado)/.test(url);
    if (error.response?.status === 401 && !esRutaPublica && leerToken()) {
      window.dispatchEvent(new CustomEvent(EVENTO_SESION_EXPIRADA));
    }
    return Promise.reject(error);
  }
);

/** Mensaje legible de un error de axios (el backend responde { error }). */
export function mensajeError(e: any, porDefecto = 'No se pudo comunicar con el servidor.'): string {
  return e?.response?.data?.error || e?.response?.data?.message || (e?.response ? porDefecto : 'Sin conexión con el servidor.');
}

export default api;
export { API_URL };
