/**
 * Raíz de composición de las sesiones: el middleware HTTP obtiene de aquí el verificador de
 * tokens y el estado de las cuentas (infraestructura/sesiones.ts), sin depender de la
 * infraestructura directamente.
 */
export { cuentaVigente, decodificarToken, type UserPayload } from '../infraestructura/sesiones';
