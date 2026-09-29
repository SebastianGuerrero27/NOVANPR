import sql from 'mssql';

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
  grupo: 'Acceso y cuentas' | 'Operación' | 'Institución';
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
    descripcion: 'Permite que el personal cree su cuenta desde la pantalla de acceso (queda con rol Operador tras verificar el correo).',
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

/** Valida y normaliza un valor según el tipo de la clave. Devuelve { valor } o { error }. */
export function validarValor(clave: string, entrada: unknown): { valor?: string; error?: string } {
  const def = DEFINICIONES.find(d => d.clave === clave);
  if (!def) return { error: `Parámetro desconocido: ${clave}` };
  const v = String(entrada ?? '').trim();
  switch (def.tipo) {
    case 'booleano':
      if (!['true', 'false'].includes(v)) return { error: `${def.etiqueta}: debe ser verdadero o falso.` };
      return { valor: v };
    case 'entero': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < (def.min ?? -Infinity) || n > (def.max ?? Infinity)) {
        return { error: `${def.etiqueta}: entero entre ${def.min} y ${def.max}.` };
      }
      return { valor: String(n) };
    }
    case 'lista': {
      const items = v.split(',').map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
      if (!items.length) return { error: `${def.etiqueta}: indique al menos un dominio.` };
      if (items.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return { error: `${def.etiqueta}: hay un dominio inválido.` };
      return { valor: items.join(',') };
    }
    case 'opcion':
      if (!def.opciones?.some(o => o.valor === v)) return { error: `${def.etiqueta}: opción inválida.` };
      return { valor: v };
    default:
      if (!v || v.length > 150) return { error: `${def.etiqueta}: entre 1 y 150 caracteres.` };
      return { valor: v };
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

/**
 * ¿Un paso de una placa del padrón puede autorizarse sin intervención del personal?
 * Combina, según `autorizacion_criterio`, la validez de la lectura (evidencias del motor) y
 * la confianza mínima. Si el motor no informó la validez (versiones anteriores o flujo del
 * navegador) solo se evalúa la confianza.
 */
export function evaluarAutorizacion(lecturaValida: boolean | null | undefined, confOcr: number | null | undefined,
                                    confDeteccion: number | null | undefined) {
  const criterio = config.texto('autorizacion_criterio');
  const confianza = evaluarConfianzaAutorizacion(confOcr, confDeteccion);
  const conValidez = typeof lecturaValida === 'boolean' && criterio !== 'confianza';
  const validezOk = !conValidez || lecturaValida === true;
  const confianzaOk = criterio === 'validez' && conValidez ? true : confianza.cumple;
  return { cumple: validezOk && confianzaOk, validezOk, confianzaOk, criterio, confianza };
}

/**
 * ¿La confianza de un paso alcanza el mínimo para autorizarlo sin intervención del personal?
 * Devuelve también el valor evaluado para explicarlo en pantalla.
 */
export function evaluarConfianzaAutorizacion(confOcr: number | null | undefined, confDeteccion: number | null | undefined) {
  const minimo = config.entero('autorizacion_confianza_minima') / 100;
  const fuente = config.texto('autorizacion_confianza_fuente');
  const valores = fuente === 'deteccion' ? [confDeteccion] : fuente === 'ambas' ? [confOcr, confDeteccion] : [confOcr];
  const conocidos = valores.map(v => (typeof v === 'number' ? v : 0));
  const evaluada = Math.min(...conocidos);
  return { cumple: evaluada >= minimo, evaluada, minimo, fuente };
}
