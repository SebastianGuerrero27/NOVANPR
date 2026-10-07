import { esRol, type Rol } from './permisos';
import { type ReglaTexto, type Validado, validarEmail, validarTexto } from './validacion';

/**
 * Cuentas del personal (dominio puro, sin E/S).
 *
 * Reglas de los datos que escribe una persona al crear o editar una cuenta (nombre, cargo,
 * correo institucional, contraseña, rol y estado), la política de bloqueo por intentos, la
 * vigencia de los enlaces de un solo uso y la continuidad de la administración: ninguna acción
 * puede dejar el sistema sin un administrador activo. Las tablas y consultas viven en
 * infraestructura/persistencia (usuariosSql.ts y authSql.ts).
 *
 * Estados de una cuenta:
 *   pendiente  registro público con el correo aún sin verificar
 *   activo     puede iniciar sesión
 *   inactivo   dada de baja por un administrador (baja lógica: se conservan su historial y su auditoría)
 */

export const ESTADOS_CUENTA = ['activo', 'inactivo', 'pendiente'] as const;
export type EstadoCuenta = typeof ESTADOS_CUENTA[number];

/** Vigencia de los enlaces de un solo uso que se envían por correo. */
export const HORAS_VERIFICACION = 24;
export const MINUTOS_RESTABLECIMIENTO = 30;
export const HORAS_CUENTA_NUEVA = 48;

/** Token de un enlace: 32 bytes aleatorios en hexadecimal (en la base se guarda solo su hash). */
export const RE_TOKEN_ENLACE = /^[a-f0-9]{64}$/;

// ─── Campos ──────────────────────────────────────────────────────────────────

/** Misma etiqueta que el formulario (frontend/src/dominio/reglas.ts → REGLAS_USUARIO): el mensaje coincide en ambos lados. */
export const REGLA_NOMBRE: ReglaTexto = { etiqueta: 'Nombres y apellidos', tipo: 'nombre', min: 3, max: 150, requerido: true };
export const REGLA_CARGO: ReglaTexto = { etiqueta: 'Cargo', tipo: 'alfanumerico', max: 100 };
/** La baja exige motivo: es lo que explica en la auditoría por qué la cuenta dejó de operar. */
export const REGLA_MOTIVO_BAJA: ReglaTexto = { etiqueta: 'Motivo de la baja', tipo: 'libre', min: 5, max: 300, requerido: true };
/** En el bloqueo el motivo sigue siendo opcional (contrato vigente), pero si llega se valida. */
export const REGLA_MOTIVO_BLOQUEO: ReglaTexto = { etiqueta: 'Motivo del bloqueo', tipo: 'libre', max: 300 };

const falla = <T>(error: string): Validado<T> => ({ ok: false, error });

/** Texto obligatorio: con `requerido`, validarTexto nunca devuelve null. */
function textoObligatorio(valor: unknown, regla: ReglaTexto): Validado<string> {
  const r = validarTexto(valor, regla);
  return r.ok ? { ok: true, valor: r.valor ?? '' } : r;
}

/**
 * Correo con el que se busca una cuenta (inicio de sesión, recuperación, reenvío): minúsculas y
 * sin espacios, sin validar el formato. Un formato inválido simplemente no encuentra cuenta y la
 * respuesta sigue siendo la genérica.
 */
export function normalizarCorreo(valor: unknown): string {
  return String(valor ?? '').trim().toLowerCase();
}

/**
 * Correo de una cuenta nueva: formato válido (dominio/validacion.ts) y de un dominio
 * institucional permitido. La lista viene de la configuración del sistema; vacía = cualquiera.
 */
export function validarCorreoInstitucional(valor: unknown, dominios: readonly string[]): Validado<string> {
  const r = validarEmail(valor, 'Correo electrónico');
  if (!r.ok) return r;
  if (dominios.length && !dominios.includes(r.valor.split('@')[1])) {
    return falla(`Solo se aceptan correos de: ${dominios.map(d => '@' + d).join(', ')}.`);
  }
  return r;
}

/** Política de contraseñas: 10 a 128 caracteres con mayúscula, minúscula, número y símbolo. */
export function validarPassword(valor: unknown): Validado<string> {
  const p = String(valor ?? '');
  if (p.length < 10) return falla('La contraseña debe tener al menos 10 caracteres.');
  if (p.length > 128) return falla('La contraseña es demasiado larga.');
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p)) {
    return falla('La contraseña debe incluir mayúscula, minúscula, número y un símbolo.');
  }
  return { ok: true, valor: p };
}

export function validarRol(valor: unknown): Validado<Rol> {
  return esRol(valor) ? { ok: true, valor } : falla('Rol inválido.');
}

export function validarEstado(valor: unknown): Validado<EstadoCuenta> {
  return (ESTADOS_CUENTA as readonly unknown[]).includes(valor) ? { ok: true, valor: valor as EstadoCuenta } : falla('Estado inválido.');
}

// ─── Entradas ────────────────────────────────────────────────────────────────

type Entrada = Record<string, unknown> | null | undefined;

export interface DatosAltaUsuario {
  email: string;
  nombre_completo: string;
  cargo: string | null;
  rol: Rol;
}

/** Alta por el administrador (la contraseña la define la persona con el enlace que recibe). */
export function leerAltaUsuario(entrada: Entrada, dominios: readonly string[]): Validado<DatosAltaUsuario> {
  const b = entrada ?? {};
  const nombre = textoObligatorio(b.nombre_completo, REGLA_NOMBRE);
  if (!nombre.ok) return nombre;
  const email = validarCorreoInstitucional(b.email, dominios);
  if (!email.ok) return email;
  const cargo = validarTexto(b.cargo, REGLA_CARGO);
  if (!cargo.ok) return cargo;
  const rol = validarRol(b.rol);
  if (!rol.ok) return rol;
  return { ok: true, valor: { email: email.valor, nombre_completo: nombre.valor, cargo: cargo.valor, rol: rol.valor } };
}

export interface DatosRegistro {
  email: string;
  nombre_completo: string;
  cargo: string | null;
  password: string;
}

/** Registro público y configuración inicial (primer administrador): la persona elige su contraseña. */
export function leerRegistro(entrada: Entrada, dominios: readonly string[]): Validado<DatosRegistro> {
  const b = entrada ?? {};
  const nombre = textoObligatorio(b.nombre_completo, REGLA_NOMBRE);
  if (!nombre.ok) return nombre;
  const email = validarCorreoInstitucional(b.email, dominios);
  if (!email.ok) return email;
  const password = validarPassword(b.password);
  if (!password.ok) return password;
  const cargo = validarTexto(b.cargo, REGLA_CARGO);
  if (!cargo.ok) return cargo;
  return { ok: true, valor: { email: email.valor, nombre_completo: nombre.valor, cargo: cargo.valor, password: password.valor } };
}

export interface DatosPerfil {
  nombre_completo: string;
  cargo: string | null;
}

/** Datos propios que la persona edita en su perfil (el correo y el rol los gestiona el administrador). */
export function leerPerfil(entrada: Entrada): Validado<DatosPerfil> {
  const b = entrada ?? {};
  const nombre = textoObligatorio(b.nombre_completo, REGLA_NOMBRE);
  if (!nombre.ok) return nombre;
  const cargo = validarTexto(b.cargo, REGLA_CARGO);
  if (!cargo.ok) return cargo;
  return { ok: true, valor: { nombre_completo: nombre.valor, cargo: cargo.valor } };
}

/** Lo que la edición necesita de la cuenta guardada. */
export interface CuentaGuardada {
  nombre_completo: string;
  cargo: string | null;
  /** undefined si el código de rol guardado no es uno de los tres vigentes */
  rol?: Rol;
  estado: string;
}

export interface DatosEdicion {
  nombre_completo: string;
  cargo: string | null;
  rol: Rol;
  estado: EstadoCuenta;
}

/**
 * Edición por el administrador: el campo que no llega conserva el valor guardado y solo se
 * valida lo que llega (un nombre antiguo fuera de la regla no impide cambiar el rol o el estado).
 */
export function leerEdicionUsuario(entrada: Entrada, actual: CuentaGuardada): Validado<DatosEdicion> {
  const b = entrada ?? {};
  let nombre = actual.nombre_completo;
  if (b.nombre_completo !== undefined) {
    const r = textoObligatorio(b.nombre_completo, REGLA_NOMBRE);
    if (!r.ok) return r;
    nombre = r.valor;
  }
  let cargo = actual.cargo;
  if (b.cargo !== undefined) {
    const r = validarTexto(b.cargo, REGLA_CARGO);
    if (!r.ok) return r;
    cargo = r.valor;
  }
  const rol = validarRol(b.rol ?? actual.rol);
  if (!rol.ok) return rol;
  const estado = validarEstado(b.estado ?? actual.estado);
  if (!estado.ok) return estado;
  return { ok: true, valor: { nombre_completo: nombre, cargo, rol: rol.valor, estado: estado.valor } };
}

/** Resumen de la edición para la auditoría: "rol Guardia → Admin; estado activo → inactivo; datos personales". */
export function describirCambios(actual: CuentaGuardada, nuevo: DatosEdicion): string {
  const cambios: string[] = [];
  if (nuevo.rol !== actual.rol) cambios.push(`rol ${actual.rol} → ${nuevo.rol}`);
  if (nuevo.estado !== actual.estado) cambios.push(`estado ${actual.estado} → ${nuevo.estado}`);
  if (nuevo.nombre_completo !== actual.nombre_completo || nuevo.cargo !== actual.cargo) cambios.push('datos personales');
  return cambios.join('; ') || 'sin cambios';
}

// ─── Continuidad de la administración ────────────────────────────────────────

/** Cuenta que sostiene la administración: rol Admin, activa y sin bloqueo administrativo. */
export function esAdministradorActivo(c: { rol?: Rol; estado: string; bloqueado: boolean }): boolean {
  return c.rol === 'Admin' && c.estado === 'activo' && !c.bloqueado;
}

/** La edición le quita la administración a una cuenta de administrador (otro rol o no activa). */
export function pierdeAdministracion(actual: { rol?: Rol }, nuevo: { rol: Rol; estado: string }): boolean {
  return actual.rol === 'Admin' && (nuevo.rol !== 'Admin' || nuevo.estado !== 'activo');
}

// ─── Inicio de sesión y enlaces ──────────────────────────────────────────────

/** Bloqueo temporal por intentos fallidos todavía vigente. */
export function bloqueoTemporalVigente(hasta: Date | string | null | undefined, ahora = new Date()): boolean {
  return !!hasta && new Date(hasta) > ahora;
}

/** Minutos que faltan para que termine el bloqueo temporal (redondeados hacia arriba). */
export function minutosRestantes(hasta: Date | string, ahora = new Date()): number {
  return Math.ceil((new Date(hasta).getTime() - ahora.getTime()) / 60000);
}

/**
 * Intento fallido: suma uno al contador y, al llegar al máximo, bloquea temporalmente la cuenta
 * y reinicia el contador (al terminar el bloqueo empieza un ciclo nuevo).
 */
export function evaluarIntentoFallido(intentosPrevios: number, maximo: number): { intentos: number; bloquear: boolean } {
  const intentos = intentosPrevios + 1;
  const bloquear = intentos >= maximo;
  return { intentos: bloquear ? 0 : intentos, bloquear };
}

/** Enlace de un solo uso vencido. */
export function enlaceVencido(expiracion: Date | string, ahora = new Date()): boolean {
  return new Date(expiracion) < ahora;
}

/**
 * Registros por tabla en la auditoría de cuentas: entre 10 y 500; 200 si el valor no es un número
 * o es cero. Es un parámetro de consulta, no un dato que se guarde: se acota en lugar de rechazarse
 * (mismo cálculo que el contrato vigente, "1.5" → 10 y "abc" → 200).
 */
export function limiteAuditoria(valor: unknown): number {
  return Math.min(500, Math.max(10, Number(valor) || 200));
}
