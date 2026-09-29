import nodemailer, { SendMailOptions, Transporter } from 'nodemailer';
import fs from 'fs';
import path from 'path';

/**
 * Correo institucional del sistema ANPR (verificación de cuenta, recuperación de
 * contraseña y notificaciones de seguridad). Adaptado del servicio SMTP de la
 * plataforma Vigilance Heart, con dos cambios de seguridad:
 *   - Se mantiene la verificación del certificado TLS (SMTP_TLS_INSECURE=true solo para
 *     servidores internos con certificado autofirmado).
 *   - Nunca se envían contraseñas por correo: solo enlaces de un solo uso.
 *
 * Sin SMTP_USER / SMTP_PASSWORD (desarrollo) el mensaje se escribe en la consola del
 * backend, incluido el enlace, para poder completar los flujos sin servidor de correo.
 */

let transporter: Transporter | null = null;
let configKey = '';

function smtpConfigurado(): boolean {
  return Boolean((process.env.SMTP_USER || '').trim() && (process.env.SMTP_PASSWORD || '').trim());
}

function getTransporter(): Transporter | null {
  if (!smtpConfigurado()) return null;
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
  const key = `${host}:${port}:${user}:${pass}`;
  if (transporter && configKey === key) return transporter;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: process.env.SMTP_TLS_INSECURE !== 'true' },
  });
  configKey = key;
  console.log(`[EMAIL] Transporte SMTP configurado: ${host}:${port} (${user})`);
  return transporter;
}

function logoAdjunto(): SendMailOptions['attachments'] {
  const candidatos = [
    path.resolve(__dirname, '../../assets/ECU911.svg.png'),
    path.resolve(process.cwd(), 'assets/ECU911.svg.png'),
    '/app/assets/ECU911.svg.png',
  ];
  const p = candidatos.find(c => fs.existsSync(c));
  return p ? [{ filename: 'ECU911.png', content: fs.readFileSync(p), cid: 'ecu911logo', contentType: 'image/png' }] : [];
}

const escapar = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

interface Contenido {
  etiqueta: string;
  titulo: string;
  parrafos: string[];         // HTML ya escapado
  boton?: { texto: string; url: string };
  aviso?: string;             // HTML ya escapado
  nota?: string;
}

/** Plantilla institucional única (cabecera ECU 911, cuerpo, botón, aviso y pie). */
function plantilla(c: Contenido): string {
  const boton = c.boton
    ? `<table role="presentation" width="100%" style="margin:24px 0 28px 0"><tr><td align="center">
         <a href="${c.boton.url}" target="_blank" style="background-color:#b91c1c;color:#ffffff;padding:14px 30px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;display:inline-block;text-transform:uppercase;letter-spacing:0.5px">${escapar(c.boton.texto)}</a>
       </td></tr></table>
       <p style="font-size:11px;color:#64748b;margin:0 0 16px 0;word-break:break-all">Si el botón no funciona, copie este enlace en su navegador:<br>${escapar(c.boton.url)}</p>`
    : '';
  const aviso = c.aviso
    ? `<table role="presentation" width="100%" style="background-color:#fffbeb;border-left:4px solid #f59e0b;margin:16px 0"><tr>
         <td style="font-size:12px;color:#92400e;line-height:1.5;padding:12px 16px">${c.aviso}</td></tr></table>`
    : '';
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapar(c.titulo)}</title></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
<table role="presentation" width="100%" style="background-color:#f1f5f9;padding:32px 10px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
  <tr><td style="background-color:#071730;padding:28px 24px 22px 24px;text-align:center;border-bottom:4px solid #b91c1c">
    <div style="background-color:#ffffff;padding:8px 18px;border-radius:10px;display:inline-block;margin-bottom:12px"><img src="cid:ecu911logo" alt="ECU 911" style="height:48px;width:auto;display:block"></div>
    <div style="font-size:11px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;font-weight:600">República del Ecuador</div>
    <div style="font-size:17px;color:#ffffff;font-weight:800;margin-top:4px">SERVICIO INTEGRADO DE SEGURIDAD ECU 911</div>
    <div style="font-size:12px;color:#cbd5e1;margin-top:2px">Sistema ANPR de Control de Ingreso Vehicular · Coordinación Zonal 3</div>
  </td></tr>
  <tr><td style="padding:32px 32px 24px 32px">
    <div style="font-size:12px;font-weight:bold;color:#b91c1c;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">${escapar(c.etiqueta)}</div>
    <h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 16px 0">${escapar(c.titulo)}</h2>
    ${c.parrafos.map(p => `<p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 14px 0">${p}</p>`).join('')}
    ${boton}${aviso}
    ${c.nota ? `<p style="font-size:12px;line-height:1.5;color:#64748b;margin:16px 0 0 0">${c.nota}</p>` : ''}
  </td></tr>
  <tr><td style="background-color:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;text-align:center">
    <p style="font-size:12px;font-weight:700;color:#071730;margin:0 0 4px 0">Servicio Integrado de Seguridad ECU 911</p>
    <p style="font-size:11px;color:#64748b;margin:0 0 6px 0">Coordinación Zonal 3 · Ambato, Tungurahua</p>
    <p style="font-size:10px;color:#94a3b8;margin:0">Mensaje automático del Sistema ANPR. No responda a este correo. © ${new Date().getFullYear()} ECU 911.</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function textoPlano(c: Contenido): string {
  const limpio = (h: string) => h.replace(/<[^>]+>/g, '');
  return [c.titulo, '', ...c.parrafos.map(limpio), c.boton ? `${c.boton.texto}: ${c.boton.url}` : '', c.aviso ? limpio(c.aviso) : '', c.nota ? limpio(c.nota) : '']
    .filter(Boolean).join('\n');
}

async function enviar(para: string, asunto: string, c: Contenido): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.log(`\n[EMAIL · modo desarrollo sin SMTP] Para: ${para}\n  Asunto: ${asunto}\n${textoPlano(c)}\n`);
    return true;
  }
  const remitente = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  try {
    await t.sendMail({
      from: `"Sistema ANPR · ECU 911" <${remitente}>`,
      to: para,
      subject: asunto,
      html: plantilla(c),
      text: textoPlano(c),
      attachments: logoAdjunto(),
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
    });
    return true;
  } catch (error: any) {
    console.error(`[EMAIL] No se pudo enviar "${asunto}" a ${para}: ${error.message}`);
    return false;
  }
}

export const emailService = {
  smtpConfigurado,

  verificacionCuenta(email: string, nombre: string, enlace: string, horas: number) {
    return enviar(email, 'Verifique su correo · Sistema ANPR ECU 911', {
      etiqueta: 'Activación de cuenta',
      titulo: 'Confirme su correo institucional',
      parrafos: [
        `Estimado/a <strong>${escapar(nombre)}</strong>:`,
        `Se registró una cuenta en el <strong>Sistema ANPR de Control de Ingreso Vehicular</strong> con este correo. Para activarla, confirme su dirección:`,
      ],
      boton: { texto: 'Verificar mi correo', url: enlace },
      aviso: `<strong>Vigencia:</strong> este enlace es válido por <strong>${horas} horas</strong> y solo puede usarse una vez.`,
      nota: 'Si usted no realizó este registro, ignore este mensaje: la cuenta no se activará.',
    });
  },

  restablecerPassword(email: string, nombre: string, enlace: string, minutos: number) {
    return enviar(email, 'Restablecimiento de contraseña · Sistema ANPR ECU 911', {
      etiqueta: 'Seguridad de la cuenta',
      titulo: 'Restablecimiento de contraseña',
      parrafos: [
        `Estimado/a <strong>${escapar(nombre)}</strong>:`,
        'Recibimos una solicitud para restablecer la contraseña de su cuenta. Para definir una nueva, use el siguiente botón:',
      ],
      boton: { texto: 'Restablecer contraseña', url: enlace },
      aviso: `<strong>Vigencia:</strong> este enlace es válido por <strong>${minutos} minutos</strong> y solo puede usarse una vez.`,
      nota: 'Si usted no lo solicitó, ignore este mensaje: su contraseña actual no cambiará.',
    });
  },

  definirPasswordCuentaNueva(email: string, nombre: string, enlace: string, horas: number, rol: string) {
    return enviar(email, 'Su cuenta en el Sistema ANPR · ECU 911', {
      etiqueta: 'Cuenta creada por un administrador',
      titulo: 'Defina su contraseña',
      parrafos: [
        `Estimado/a <strong>${escapar(nombre)}</strong>:`,
        `Un administrador creó su cuenta en el Sistema ANPR con el rol <strong>${escapar(rol)}</strong>. Para ingresar, defina su contraseña:`,
      ],
      boton: { texto: 'Definir contraseña', url: enlace },
      aviso: `<strong>Vigencia:</strong> este enlace es válido por <strong>${horas} horas</strong>.`,
    });
  },

  passwordCambiada(email: string, nombre: string) {
    return enviar(email, 'Su contraseña fue cambiada · Sistema ANPR ECU 911', {
      etiqueta: 'Notificación de seguridad',
      titulo: 'Contraseña actualizada',
      parrafos: [
        `Estimado/a <strong>${escapar(nombre)}</strong>:`,
        `La contraseña de su cuenta se cambió el ${new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}.`,
      ],
      aviso: 'Si usted <strong>no</strong> realizó este cambio, comuníquese de inmediato con el administrador del sistema.',
    });
  },

  cuentaBloqueada(email: string, nombre: string, minutos: number) {
    return enviar(email, 'Cuenta bloqueada temporalmente · Sistema ANPR ECU 911', {
      etiqueta: 'Notificación de seguridad',
      titulo: 'Cuenta bloqueada por intentos fallidos',
      parrafos: [
        `Estimado/a <strong>${escapar(nombre)}</strong>:`,
        `Su cuenta se bloqueó durante <strong>${minutos} minutos</strong> por varios intentos de inicio de sesión fallidos.`,
      ],
      aviso: 'Si no fue usted, restablezca su contraseña y avise al administrador del sistema.',
    });
  },
};
