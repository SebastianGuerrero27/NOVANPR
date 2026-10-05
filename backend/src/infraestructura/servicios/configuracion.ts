import sql from 'mssql';
import { cumpleCriterioLectura, CriterioAutorizacion, FuenteConfianza, PoliticaAutorizacion } from '../../dominio/decisionAcceso';
import { validarParametro } from '../../dominio/configuracion';

/**
 * Parámetros del sistema editables por el administrador (tabla ConfiguracionSistema).
 * Mientras una clave no se haya guardado rige la variable de entorno y, en su defecto,
 * el valor por omisión documentado aquí. Los valores se mantienen en memoria para que
 * las lecturas sean síncronas (login, registro, pipeline) y se recargan al guardar.
 */

type Tipo = 'booleano' | 'entero' | 'lista' | 'texto' | 'opcion';

interface Definicion {
  clave: string;
  tipo: Tipo;
  etiqueta: string;
  descripcion: string;
  grupo: 'Acceso y cuentas' | 'Operación' | 'Notificaciones' | 'Institución';
  env?: string;
  omision: string;
  min?: number;
  max?: number;
  opciones?: { valor: string; etiqueta: string }[];
}

export const DEFINICIONES: Definicion[] = [
  {
    clave: 'registro_publico_habilitado', tipo: 'booleano', grupo: 'Acceso y cuentas',
    etiqueta: 'Registro público de cuentas',
    descripcion: 'Permite que el personal cree su cuenta desde la pantalla de acceso (queda con rol Guardia tras verificar el correo).',
    env: 'REGISTRO_PUBLICO_HABILITADO', omision: 'true',
  },
  {
    clave: 'dominios_correo', tipo: 'lista', grupo: 'Acceso y cuentas',
    etiqueta: 'Dominios de correo permitidos',
    descripcion: 'Solo se aceptan cuentas con estos dominios, separados por coma.',
    env: 'ALLOWED_EMAIL_DOMAINS', omision: 'ecu911.gob.ec',
  },
  {
    clave: 'sesion_horas', tipo: 'entero', grupo: 'Acceso y cuentas',
    etiqueta: 'Duración de la sesión (horas)',
    descripcion: 'Tiempo tras el cual la sesión se cierra y hay que volver a ingresar. Aplica a los nuevos inicios de sesión.',
    omision: '8', min: 1, max: 24,
  },
  {
    clave: 'login_max_intentos', tipo: 'entero', grupo: 'Acceso y cuentas',
    etiqueta: 'Intentos fallidos antes del bloqueo',
    descripcion: 'Número de contraseñas incorrectas consecutivas que bloquean temporalmente la cuenta.',
    env: 'LOGIN_MAX_INTENTOS', omision: '5', min: 3, max: 10,
  },
  {
    clave: 'login_minutos_bloqueo', tipo: 'entero', grupo: 'Acceso y cuentas',
    etiqueta: 'Minutos de bloqueo temporal',
    descripcion: 'Duración del bloqueo automático por intentos fallidos.',
    env: 'LOGIN_MINUTOS_BLOQUEO', omision: '15', min: 5, max: 1440,
  },
  {
    clave: 'verificar_vehiculo_autorizados', tipo: 'booleano', grupo: 'Operación',
    etiqueta: 'Verificar marca y color en vehículos autorizados',
    descripcion: 'Si el vehículo observado no coincide con el registrado, el ingreso queda pendiente de revisión en lugar de autorizarse.',
    env: 'VERIFICAR_VEHICULO_AUTORIZADOS', omision: 'true',
  },
  {
    clave: 'autorizacion_criterio', tipo: 'opcion', grupo: 'Operación',
    etiqueta: 'Criterio de autorización automática',
    descripcion: 'Lectura válida: el motor confirmó la placa con evidencias independientes (formato ANT, placa completa en el cuadro, fila de caracteres y consenso de varios cuadros o del segundo OCR). Si una placa del padrón no cumple el criterio, el personal confirma el ingreso.',
    omision: 'validez_y_confianza',
    opciones: [
      { valor: 'validez_y_confianza', etiqueta: 'Lectura válida y confianza mínima (recomendado)' },
      { valor: 'validez', etiqueta: 'Solo lectura válida' },
      { valor: 'confianza', etiqueta: 'Solo confianza mínima' },
    ],
  },
  {
    clave: 'autorizacion_confianza_minima', tipo: 'entero', grupo: 'Operación',
    etiqueta: 'Confianza mínima para autorizar automáticamente (%)',
    descripcion: 'Una placa del padrón se autoriza sola solo si la confianza alcanza este valor; si es menor, el ingreso queda pendiente para que el personal confirme la placa. Las alertas se emiten siempre, sin importar la confianza.',
    omision: '82', min: 50, max: 100,
  },
  {
    clave: 'autorizacion_confianza_fuente', tipo: 'opcion', grupo: 'Operación',
    etiqueta: 'Confianza evaluada para la autorización automática',
    descripcion: 'Lectura: certeza de los caracteres leídos (recomendado, es lo que garantiza que la placa sea la correcta). Detección: certeza de que el recuadro es una placa. Ambas: se exigen las dos.',
    omision: 'ocr',
    opciones: [
      { valor: 'ocr', etiqueta: 'Lectura de la placa (OCR)' },
      { valor: 'deteccion', etiqueta: 'Detección de la placa' },
      { valor: 'ambas', etiqueta: 'Lectura y detección' },
    ],
  },
  {
    clave: 'aviso_vencimiento_dias', tipo: 'entero', grupo: 'Operación',
    etiqueta: 'Aviso de autorizaciones por vencer (días)',
    descripcion: 'Las autorizaciones que vencen dentro de este plazo se destacan en el panel.',
    omision: '7', min: 1, max: 90,
  },
  {
    clave: 'notif_escalamiento_segundos', tipo: 'entero', grupo: 'Notificaciones',
    etiqueta: 'Escalar alarmas no atendidas (segundos)',
    descripcion: 'Si nadie reconoce una alarma crítica o alta en este tiempo, se notifica al supervisor y al administrador (ISA-18.2). 0 desactiva el escalamiento.',
    env: 'NOTIF_ESCALAMIENTO_SEGUNDOS', omision: '90', min: 0, max: 3600,
  },
  {
    clave: 'notif_escalamiento_correo', tipo: 'booleano', grupo: 'Notificaciones',
    etiqueta: 'Enviar por correo las alarmas escaladas',
    descripcion: 'Además del aviso en el sistema y del push del navegador, envía un correo a quienes reciben las alarmas escaladas (requiere SMTP).',
    env: 'NOTIF_ESCALAMIENTO_CORREO', omision: 'false',
  },
  {
    clave: 'notif_reincidencia_umbral', tipo: 'entero', grupo: 'Notificaciones',
    etiqueta: 'Intentos denegados que avisan al gestor de accesos',
    descripcion: 'Cuando una misma placa sin permiso intenta ingresar este número de veces en 24 horas, se avisa al gestor de accesos para que la registre o investigue.',
    env: 'NOTIF_REINCIDENCIA_UMBRAL', omision: '3', min: 2, max: 20,
  },
  {
    clave: 'notif_push_habilitado', tipo: 'booleano', grupo: 'Notificaciones',
    etiqueta: 'Notificaciones push del navegador',
    descripcion: 'Entrega las alarmas críticas y altas aunque la pestaña del sistema esté cerrada o en segundo plano (Web Push con claves VAPID).',
    env: 'NOTIF_PUSH_HABILITADO', omision: 'true',
  },
  {
    clave: 'notif_retencion_dias', tipo: 'entero', grupo: 'Notificaciones',
    etiqueta: 'Conservar notificaciones (días)',
    descripcion: 'Las notificaciones más antiguas se eliminan automáticamente cada día. La auditoría de operaciones no se ve afectada.',
    env: 'NOTIF_RETENCION_DIAS', omision: '90', min: 7, max: 730,
  },
  {
    clave: 'unidad_institucional', tipo: 'texto', grupo: 'Institución',
    etiqueta: 'Unidad institucional',
    descripcion: 'Nombre de la unidad que aparece en el encabezado, reportes y exportaciones.',
    env: 'UNIDAD_INSTITUCIONAL', omision: 'Coordinación Zonal 3 · Ambato',
  },
];

const guardados = new Map<string, { valor: string; fecha: Date; por: string | null }>();

function crudo(clave: string): string {
  const def = DEFINICIONES.find(d => d.clave === clave);
  if (!def) throw new Error(`Clave de configuración desconocida: ${clave}`);
  return guardados.get(clave)?.valor ?? (def.env ? process.env[def.env] : undefined) ?? def.omision;
}

export const config = {
  booleano: (clave: string) => !['false', '0', 'no'].includes(crudo(clave).trim().toLowerCase()),
  entero: (clave: string) => Number.parseInt(crudo(clave), 10),
  texto: (clave: string) => crudo(clave).trim(),
  lista: (clave: string) => crudo(clave).split(',').map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
};

export async function cargarConfiguracion(db: sql.ConnectionPool): Promise<void> {
  try {
    const r = await db.request().query(`
      SELECT c.clave, c.valor, c.fecha_actualizacion, u.email
      FROM ConfiguracionSistema c LEFT JOIN Usuarios u ON u.id = c.actualizado_por`);
    guardados.clear();
    for (const f of r.recordset) guardados.set(f.clave, { valor: f.valor, fecha: f.fecha_actualizacion, por: f.email });
  } catch (e: any) {
    console.error('[CONFIG] No se pudo cargar la configuración del sistema:', e.message);
  }
}

export async function guardarValor(db: sql.ConnectionPool, clave: string, valor: string, usuarioId: number): Promise<void> {
  await db.request()
    .input('clave', sql.VarChar(60), clave)
    .input('valor', sql.NVarChar(500), valor)
    .input('uid', sql.Int, usuarioId)
    .query(`
      MERGE ConfiguracionSistema AS t
      USING (SELECT @clave AS clave) AS s ON t.clave = s.clave
      WHEN MATCHED THEN UPDATE SET valor = @valor, actualizado_por = @uid, fecha_actualizacion = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (clave, valor, actualizado_por) VALUES (@clave, @valor, @uid);`);
}

/** Listado para la pantalla de configuración: valor vigente y su origen. */
export function listarConfiguracion() {
  return DEFINICIONES.map(d => {
    const g = guardados.get(d.clave);
    const deEnv = d.env && process.env[d.env] !== undefined;
    return {
      clave: d.clave, tipo: d.tipo, etiqueta: d.etiqueta, descripcion: d.descripcion, grupo: d.grupo,
      min: d.min, max: d.max, opciones: d.opciones,
      valor: crudo(d.clave),
      origen: g ? 'sistema' : deEnv ? 'entorno' : 'omision',
      actualizado_por: g?.por ?? null,
      fecha_actualizacion: g?.fecha ?? null,
    };
  });
}

export interface EvidenciaLectura {
  valido?: boolean;
  formato?: boolean;
  dentro_cuadro?: boolean;
  caracteres?: number;
  lecturas?: number;
  verificador_coincide?: boolean;
  motivos?: string[];
  angulo?: number;
  regularidad?: number;
  bordes_hallados?: number;
  lectura_ocr?: string | null;
  lectura_verificador?: string | null;
}

/** Política de autorización automática vigente (parámetros de la pantalla de configuración). */
export function politicaAutorizacion(): PoliticaAutorizacion {
  return {
    criterio: config.texto('autorizacion_criterio') as CriterioAutorizacion,
    confianzaMinima: config.entero('autorizacion_confianza_minima') / 100,
    fuenteConfianza: config.texto('autorizacion_confianza_fuente') as FuenteConfianza,
    verificarVehiculo: config.booleano('verificar_vehiculo_autorizados'),
  };
}
