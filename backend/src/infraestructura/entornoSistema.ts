import type { PuertoEntorno } from '../aplicacion/configuracion';
import { emailService } from './servicios/emailService';
import { estadoServicioAnpr } from './servicios/servicioAnpr';
import { ZONA_HORARIA } from './servicios/tiempo';

/**
 * Datos del entorno de ejecución para la pantalla de configuración (solo lectura): zona
 * horaria, correo saliente, URL del frontend y estado del motor ANPR. Vienen de las variables de
 * entorno del servidor y no se editan desde la aplicación.
 */
export const entornoSistema: PuertoEntorno = {
  async describir() {
    const anpr = await estadoServicioAnpr();
    const correo = emailService.smtpConfigurado();
    return {
      zona_horaria: ZONA_HORARIA,
      correo_configurado: correo,
      remitente_correo: correo ? (process.env.SMTP_FROM || process.env.SMTP_USER || null) : null,
      frontend_url: process.env.FRONTEND_URL || null,
      entorno: process.env.NODE_ENV || 'development',
      anpr,
    };
  },
};
