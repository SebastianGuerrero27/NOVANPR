import axios from 'axios';

// La URL apunta al backend expuesto en localhost para el navegador del cliente.
// Normalizar para evitar que VITE_API_URL incluya el sufijo '/api' accidentalmente
// y luego añadir el prefijo real de la API una sola vez.
let API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
API_URL = API_URL.replace(/\/api\/?$/, '');

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para inyectar automáticamente el token JWT
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default api;
export { API_URL };
