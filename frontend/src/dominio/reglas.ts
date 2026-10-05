import type { ReglaTexto } from './validacion';

/**
 * Regla de cada campo de texto que registra una persona, por formulario: tipo de texto,
 * longitud y obligatoriedad (validarTexto de lib/validacion.ts). Replica las definiciones del
 * dominio del backend (p. ej. backend/src/dominio/listas.ts); el mensaje de error usa la
 * etiqueta que la persona ve junto al campo. La API vuelve a validar cada dato.
 */

type Reglas = Record<string, ReglaTexto>;

/** Datos del vehículo: lista blanca, lista negra y solicitudes de acceso. */
export const REGLAS_VEHICULO = {
  tipo_vehiculo: { etiqueta: 'Tipo de vehículo', tipo: 'alfanumerico', max: 50 },
  marca: { etiqueta: 'Marca', tipo: 'alfanumerico', max: 50 },
  modelo: { etiqueta: 'Modelo', tipo: 'alfanumerico', max: 50 },
  color: { etiqueta: 'Color', tipo: 'letras', max: 30 },
} satisfies Reglas;

export const REGLA_OBSERVACIONES: ReglaTexto = { etiqueta: 'Observaciones', tipo: 'libre', max: 255 };

/** Lista blanca (dominio/listas.ts → LISTA_BLANCA). */
export const REGLAS_LISTA_BLANCA = {
  propietario: { etiqueta: 'Propietario o responsable', tipo: 'nombre', max: 150, min: 3, requerido: true },
  departamento: { etiqueta: 'Departamento o unidad', tipo: 'alfanumerico', max: 100 },
} satisfies Reglas;

/** Lista negra (dominio/listas.ts → LISTA_NEGRA). */
export const REGLAS_LISTA_NEGRA = {
  motivo: { etiqueta: 'Motivo', tipo: 'libre', max: 255, min: 5, requerido: true },
} satisfies Reglas;

/** Solicitud de acceso (mismo cuerpo para crear y editar). */
export const REGLAS_SOLICITUD = {
  propietario: { etiqueta: 'Conductor o responsable', tipo: 'nombre', max: 150, min: 3, requerido: true },
  departamento: { etiqueta: 'Unidad que visita', tipo: 'alfanumerico', max: 100 },
  motivo: { etiqueta: 'Motivo del ingreso', tipo: 'libre', max: 300, min: 5, requerido: true },
} satisfies Reglas;

/** Comentario del gestor al aprobar una solicitud (opcional). */
export const REGLA_COMENTARIO_APROBACION: ReglaTexto = { etiqueta: 'Comentario', tipo: 'libre', max: 300 };

/** Cámaras. */
export const REGLAS_CAMARA = {
  nombre: { etiqueta: 'Nombre', tipo: 'alfanumerico', max: 100, min: 3, requerido: true },
  ubicacion: { etiqueta: 'Ubicación', tipo: 'alfanumerico', max: 150, min: 3, requerido: true },
} satisfies Reglas;

/** Cuentas de usuario (dominio/usuarios.ts): alta por el administrador, edición, perfil propio y registro público. */
export const REGLAS_USUARIO = {
  nombre_completo: { etiqueta: 'Nombres y apellidos', tipo: 'nombre', max: 150, min: 3, requerido: true },
  cargo: { etiqueta: 'Cargo', tipo: 'alfanumerico', max: 100 },
} satisfies Reglas;

/** Baja lógica de una cuenta: el motivo explica en la auditoría por qué dejó de operar. */
export const REGLA_MOTIVO_BAJA: ReglaTexto = { etiqueta: 'Motivo de la baja', tipo: 'libre', max: 300, min: 5, requerido: true };

/** Validación de una lectura por el personal. */
export const REGLA_OBSERVACION_VALIDACION: ReglaTexto = { etiqueta: 'Observación', tipo: 'libre', max: 300 };
/** Autorización por excepción: el motivo es obligatorio y queda auditado. */
export const REGLA_MOTIVO_EXCEPCION: ReglaTexto = { etiqueta: 'Motivo de la excepción', tipo: 'libre', max: 300, min: 5, requerido: true };
/** Registro manual de un paso. */
export const REGLA_MOTIVO_MANUAL: ReglaTexto = { etiqueta: 'Motivo del registro manual', tipo: 'libre', max: 300, min: 5, requerido: true };

/** Motivo que se pide al confirmar una acción y queda en la auditoría (retiros, bloqueos, bajas, rechazos). */
export const REGLA_MOTIVO_AUDITORIA: ReglaTexto = { etiqueta: 'Motivo', tipo: 'libre', max: 300, min: 5, requerido: true };

/** Eliminación de ingresos: un registro exige 3 caracteres; la eliminación masiva, 5. */
export const reglaMotivoEliminacion = (min: number): ReglaTexto => ({ etiqueta: 'Motivo', tipo: 'libre', max: 300, min, requerido: true });

/** Consulta del propietario (convenio DINARDAP / ANT): base legal de al menos 10 caracteres. */
export const REGLA_MOTIVO_CONSULTA: ReglaTexto = { etiqueta: 'Motivo de la consulta', tipo: 'libre', max: 255, min: 10, requerido: true };

/** Parámetro de configuración de texto libre (p. ej. unidad institucional). */
export const REGLA_PARAMETRO_TEXTO: ReglaTexto = { etiqueta: 'Valor', tipo: 'libre', max: 150, requerido: true };

/** Retención de la auditoría (dominio/auditoria.ts → DIAS_RETENCION): antigüedad, en días, de lo que pasa al archivo (1 a 10 años). */
export const RETENCION_AUDITORIA = { min: 365, max: 3650, omision: 365 } as const;

/** Texto de búsqueda de la auditoría: la API usa hasta 100 caracteres. */
export const LARGO_BUSQUEDA = 100;
