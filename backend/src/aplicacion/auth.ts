import { type Actor, errorConflicto, errorProhibido, errorValidacion } from './comun';
import type {
  NuevaCuenta, PuertoAuditoriaCuentas, PuertoClaves, PuertoCorreoCuentas, PuertoTokens, Visitante,
} from './usuarios';
import { NOMBRE_ROL, type Permiso, permisosDe, type Rol } from '../dominio/permisos';
import {
  bloqueoTemporalVigente, type DatosPerfil, enlaceVencido, evaluarIntentoFallido, HORAS_VERIFICACION, leerPerfil,
  leerRegistro, minutosRestantes, MINUTOS_RESTABLECIMIENTO, normalizarCorreo, RE_TOKEN_ENLACE, validarPassword,
} from '../dominio/usuarios';

/**
 * Casos de uso de la autenticación y del ciclo de vida de la cuenta: estado del sistema,
 * configuración inicial (primer administrador), inicio de sesión con bloqueo temporal por
 * intentos, registro público con verificación del correo, recuperación de la contraseña con un
 * enlace de un solo uso, datos de la sesión, perfil propio y cambio de contraseña.
 *
 * Seguridad (OWASP ASVS V2 y V3):
 *   - Ninguna respuesta revela si un correo está registrado: el inicio de sesión responde lo
 *     mismo y tarda lo mismo (comparación contra un hash ficticio), y la recuperación de la
 *     contraseña y el reenvío de la verificación responden siempre lo mismo.
 *   - El estado de la cuenta (pendiente o inactiva) se revela solo a quien conoce la contraseña.
 *   - Los enlaces viajan en el correo; en la base se guarda solo el hash del token.
 *   - Cada intento de inicio de sesión queda en AuditoriaAccesos y cada cambio de la cuenta, en
 *     AuditoriaUsuarios.
 */

// ─── Rechazos con código HTTP propio ─────────────────────────────────────────

/**
 * Rechazos de la autenticación cuyo código HTTP no está en el catálogo común (ErrorAplicacion).
 * La capa HTTP los traduce (interfaz/http/rutas/auth.ts):
 *
 *   credenciales            401  correo o contraseña incorrectos
 *   sesion_inactiva         401  la cuenta de la sesión ya no está activa
 *   bloqueo_administrativo  403  cuenta bloqueada por un administrador
 *   no_verificado           403  correo sin verificar (codigo EMAIL_NO_VERIFICADO)
 *   inactiva                403  cuenta desactivada o dada de baja
 *   enlace_vencido          410  el enlace de un solo uso expiró
 *   bloqueo_temporal        423  bloqueo por intentos fallidos
 */
export type MotivoRechazo =
  'credenciales' | 'sesion_inactiva' | 'bloqueo_administrativo' | 'no_verificado' | 'inactiva' | 'enlace_vencido' | 'bloqueo_temporal';

export class RechazoAutenticacion extends Error {
  constructor(readonly motivo: MotivoRechazo, mensaje: string, readonly codigo?: string) {
    super(mensaje);
    this.name = 'RechazoAutenticacion';
  }
}

// ─── Puertos ─────────────────────────────────────────────────────────────────

/** Cuenta tal como la necesita el inicio de sesión (incluye el hash de la contraseña). */
export interface CuentaAcceso {
  id: number;
  email: string;
  nombre_completo: string;
  cargo: string | null;
  password_hash: string;
  /** undefined si el código de rol guardado no es uno de los tres vigentes */
  rol?: Rol;
  estado: string;
  email_verificado: boolean;
  bloqueado: boolean;
  /** Fin del bloqueo temporal por intentos (puede estar vencido) */
  bloqueado_hasta: Date | null;
  intentos_fallidos: number;
}

/** Datos de la cuenta de la sesión vigente (GET /api/auth/me). */
export interface CuentaSesion {
  id: number;
  email: string;
  nombre_completo: string;
  cargo: string | null;
  estado: string;
  rol?: Rol;
  /** Nombre del rol en la tabla Roles */
  rol_nombre: string;
  fecha_ultimo_acceso: Date | null;
  fecha_creacion: Date;
}

/** Enlaces de un solo uso: verificación del correo (VerificacionEmail) y restablecimiento (RestablecimientoPassword). */
export type TipoEnlace = 'verificacion' | 'restablecimiento';

export interface EnlaceGuardado {
  id: number;
  usuario_id: number;
  usado: boolean;
  fecha_expiracion: Date;
  /** Correo y nombre de la cuenta dueña del enlace */
  email: string;
  nombre_completo: string;
}

/** Cuenta que crea la propia persona (elige su contraseña); el rol lo fija el flujo. */
export type CuentaPropia = Omit<NuevaCuenta, 'rol'>;

export interface RepositorioAuth {
  /** ¿Existe alguna cuenta con rol de administrador, en cualquier estado? */
  hayAdministrador(): Promise<boolean>;
  porEmail(email: string): Promise<CuentaAcceso | null>;
  sesion(id: number): Promise<CuentaSesion | null>;
  credenciales(id: number): Promise<{ id: number; email: string; nombre_completo: string; password_hash: string } | null>;
  /**
   * Primer administrador (activo y verificado), en una transacción serializable que vuelve a
   * comprobar que no exista ninguno: false si otra solicitud simultánea lo creó antes.
   */
  crearPrimerAdministrador(c: CuentaPropia): Promise<boolean>;
  /** Registro público: rol Guardia, estado pendiente y correo sin verificar; devuelve el id */
  registrar(c: CuentaPropia): Promise<number>;
  /** Contraseña incorrecta: guarda el contador y, si corresponde, el bloqueo temporal */
  registrarIntentoFallido(id: number, intentos: number, bloquear: boolean, minutosBloqueo: number): Promise<void>;
  /** Inicio de sesión correcto: reinicia los intentos, quita el bloqueo temporal y anota la fecha */
  registrarAcceso(id: number): Promise<void>;
  actualizarPerfil(id: number, p: DatosPerfil): Promise<void>;
  cambiarPassword(id: number, passwordHash: string): Promise<void>;
  /** ¿Se emitió un enlace de ese tipo para la cuenta en el último minuto? (límite de reenvíos) */
  enlaceReciente(tipo: TipoEnlace, usuarioId: number): Promise<boolean>;
  /** Anula los enlaces pendientes de ese tipo y guarda uno nuevo con su vigencia */
  emitirEnlace(tipo: TipoEnlace, usuarioId: number, tokenHash: string, minutos: number): Promise<void>;
  buscarEnlace(tipo: TipoEnlace, tokenHash: string): Promise<EnlaceGuardado | null>;
  /** Marca el enlace como usado, verifica el correo y activa la cuenta pendiente */
  confirmarCorreo(enlaceId: number, usuarioId: number): Promise<void>;
  /**
   * Marca el enlace como usado y guarda la nueva contraseña: reinicia los intentos y el bloqueo
   * temporal, verifica el correo y activa la cuenta pendiente.
   */
  restablecerPassword(enlaceId: number, usuarioId: number, passwordHash: string): Promise<void>;
}

/** Parámetros del sistema que rigen las cuentas (configuración editable por el administrador). */
export interface PuertoParametrosCuentas {
  registroHabilitado(): boolean;
  dominiosPermitidos(): string[];
  unidadInstitucional(): string;
  maxIntentos(): number;
  minutosBloqueo(): number;
}

/** Emisión del token de sesión (JWT firmado). */
export interface PuertoSesiones {
  firmar(u: { id: number; email: string; nombre: string; rol: Rol }): string;
}

export interface DependenciasAuth {
  repositorio: RepositorioAuth;
  auditoria: PuertoAuditoriaCuentas;
  correo: PuertoCorreoCuentas;
  tokens: PuertoTokens;
  claves: PuertoClaves;
  sesiones: PuertoSesiones;
  parametros: PuertoParametrosCuentas;
  /** URL pública del frontend (enlaces de los correos) */
  urlFrontend: () => string;
  /** Fallo en un flujo de respuesta genérica: se registra en el log y la respuesta no cambia */
  registrarFallo: (contexto: string, error: unknown) => void;
}

// ─── Respuestas ──────────────────────────────────────────────────────────────

/** Usuario de la sesión tal como lo recibe el frontend (arma el menú con `permisos`). */
export interface UsuarioSesion {
  id: number;
  email: string;
  /** Igual a email; se conserva por compatibilidad con clientes que leían `username` */
  username: string;
  nombre: string;
  cargo: string | null;
  rol: Rol;
  rol_nombre: string;
  permisos: Permiso[];
}

export interface Sesion {
  token: string;
  user: UsuarioSesion;
}

export type ResultadoVerificacion = 'verificado' | 'ya_verificado';

const CREDENCIALES_INVALIDAS = 'Correo o contraseña incorrectos.';
const YA_CONFIGURADO = 'El sistema ya tiene un administrador. Inicie sesión.';

type Entrada = Record<string, unknown>;
const cuerpo = (entrada: unknown): Entrada => (entrada && typeof entrada === 'object' ? entrada as Entrada : {});

/** Solo existen tres roles (dominio/permisos.ts): un código desconocido en la base es un error de datos. */
function rolVigente(rol: Rol | undefined, id: number): Rol {
  if (!rol) throw new Error(`La cuenta ${id} tiene un rol no reconocido.`);
  return rol;
}

export function casosAuth(d: DependenciasAuth) {
  const enlace = (ruta: 'verificar-email' | 'restablecer-password', token: string) => `${d.urlFrontend()}/${ruta}?token=${token}`;

  /** Token firmado y datos del usuario con los permisos de su rol. */
  function sesion(u: CuentaAcceso): Sesion {
    const rol = rolVigente(u.rol, u.id);
    return {
      token: d.sesiones.firmar({ id: u.id, email: u.email, nombre: u.nombre_completo, rol }),
      user: {
        id: u.id, email: u.email, username: u.email, nombre: u.nombre_completo, cargo: u.cargo,
        rol, rol_nombre: NOMBRE_ROL[rol], permisos: permisosDe(rol),
      },
    };
  }

  return {
    /** Datos públicos para la pantalla de acceso (¿falta la configuración inicial?, ¿registro?, ¿SMTP?). */
    async estado() {
      return {
        configuracion_inicial_requerida: !(await d.repositorio.hayAdministrador()),
        registro_habilitado: d.parametros.registroHabilitado(),
        smtp_configurado: d.correo.smtpConfigurado(),
        dominios_permitidos: d.parametros.dominiosPermitidos(),
        unidad_institucional: d.parametros.unidadInstitucional(),
      };
    },

    /** Crea el PRIMER administrador (solo si no existe ninguno) y devuelve la sesión iniciada. */
    async configuracionInicial(entrada: unknown, visitante: Visitante): Promise<Sesion> {
      const datos = leerRegistro(cuerpo(entrada), d.parametros.dominiosPermitidos());
      if (!datos.ok) throw errorValidacion(datos.error);
      const { email, nombre_completo, cargo, password } = datos.valor;
      // Sin administrador se cifra la contraseña; la transacción vuelve a comprobarlo (dos solicitudes simultáneas)
      if (await d.repositorio.hayAdministrador()) throw errorConflicto(YA_CONFIGURADO);
      const creado = await d.repositorio.crearPrimerAdministrador({ email, nombre_completo, cargo, passwordHash: await d.claves.cifrar(password) });
      if (!creado) throw errorConflicto(YA_CONFIGURADO);
      const u = await d.repositorio.porEmail(email);
      if (!u) throw new Error('No se encontró el administrador recién creado.');
      await d.auditoria.cuenta(visitante, 'CONFIGURACION_INICIAL', { id: u.id, email }, 'Primer administrador del sistema');
      return sesion(u);
    },

    /**
     * Inicio de sesión. Cada intento queda en AuditoriaAccesos con su motivo (ok, credenciales,
     * bloqueado, bloqueo_por_intentos, no_verificado, inactivo). Al llegar al máximo de intentos
     * fallidos la cuenta se bloquea temporalmente y se avisa por correo a su titular.
     */
    async login(entrada: unknown, visitante: Visitante): Promise<Sesion> {
      const b = cuerpo(entrada);
      const email = normalizarCorreo(b.email ?? b.username);
      const password = String(b.password ?? '');
      if (!email || !password) throw errorValidacion('Ingrese su correo y contraseña.');

      const u = await d.repositorio.porEmail(email);
      if (!u) {
        // Mismo costo de tiempo que con una cuenta existente (no revela qué correos existen)
        await d.claves.compararFicticio(password);
        await d.auditoria.acceso(visitante, email, null, false, 'credenciales');
        throw new RechazoAutenticacion('credenciales', CREDENCIALES_INVALIDAS);
      }

      if (u.bloqueado_hasta && bloqueoTemporalVigente(u.bloqueado_hasta)) {
        const minutos = minutosRestantes(u.bloqueado_hasta);
        await d.auditoria.acceso(visitante, email, u.id, false, 'bloqueado');
        throw new RechazoAutenticacion('bloqueo_temporal', `Cuenta bloqueada temporalmente por intentos fallidos. Intente en ${minutos} min.`);
      }
      if (u.bloqueado) {
        await d.auditoria.acceso(visitante, email, u.id, false, 'bloqueado');
        throw new RechazoAutenticacion('bloqueo_administrativo', 'Cuenta bloqueada por un administrador.');
      }

      if (!(await d.claves.comparar(password, u.password_hash))) {
        const { intentos, bloquear } = evaluarIntentoFallido(u.intentos_fallidos, d.parametros.maxIntentos());
        const minutos = d.parametros.minutosBloqueo();
        await d.repositorio.registrarIntentoFallido(u.id, intentos, bloquear, minutos);
        await d.auditoria.acceso(visitante, email, u.id, false, bloquear ? 'bloqueo_por_intentos' : 'credenciales');
        if (bloquear) {
          await d.correo.cuentaBloqueada(u.email, u.nombre_completo, minutos);
          throw new RechazoAutenticacion('bloqueo_temporal', `Demasiados intentos fallidos. Cuenta bloqueada ${minutos} minutos.`);
        }
        throw new RechazoAutenticacion('credenciales', CREDENCIALES_INVALIDAS);
      }

      // Contraseña correcta: el estado de la cuenta se revela solo a quien conoce la contraseña
      if (u.estado === 'pendiente' || !u.email_verificado) {
        await d.auditoria.acceso(visitante, email, u.id, false, 'no_verificado');
        throw new RechazoAutenticacion('no_verificado', 'Debe verificar su correo antes de ingresar.', 'EMAIL_NO_VERIFICADO');
      }
      if (u.estado !== 'activo') {
        await d.auditoria.acceso(visitante, email, u.id, false, 'inactivo');
        throw new RechazoAutenticacion('inactiva', 'La cuenta está inactiva. Contacte al administrador.');
      }

      const s = sesion(u);
      await d.repositorio.registrarAcceso(u.id);
      await d.auditoria.acceso(visitante, email, u.id, true, 'ok');
      return s;
    },

    /** Registro público (rol Guardia): la cuenta queda pendiente hasta verificar el correo. Devuelve si el correo salió. */
    async registrar(entrada: unknown, visitante: Visitante): Promise<{ enviado: boolean }> {
      if (!d.parametros.registroHabilitado()) {
        throw errorProhibido('El registro público está deshabilitado. Solicite su cuenta al administrador.');
      }
      const datos = leerRegistro(cuerpo(entrada), d.parametros.dominiosPermitidos());
      if (!datos.ok) throw errorValidacion(datos.error);
      const { email, nombre_completo, cargo, password } = datos.valor;
      if (await d.repositorio.porEmail(email)) throw errorConflicto('Ya existe una cuenta con ese correo.');
      const id = await d.repositorio.registrar({ email, nombre_completo, cargo, passwordHash: await d.claves.cifrar(password) });
      const { token, hash } = d.tokens.generar();
      await d.repositorio.emitirEnlace('verificacion', id, hash, HORAS_VERIFICACION * 60);
      const enviado = await d.correo.verificacionCuenta(email, nombre_completo, enlace('verificar-email', token), HORAS_VERIFICACION);
      await d.auditoria.cuenta(visitante, 'REGISTRO', { id, email }, 'Registro público; pendiente de verificación');
      return { enviado };
    },

    /** Activa la cuenta con el token del correo de verificación. */
    async verificarEmail(token: unknown, visitante: Visitante): Promise<ResultadoVerificacion> {
      const t = String(token ?? '');
      if (!RE_TOKEN_ENLACE.test(t)) throw errorValidacion('Enlace de verificación inválido.');
      const v = await d.repositorio.buscarEnlace('verificacion', d.tokens.hash(t));
      if (!v) throw errorValidacion('Enlace de verificación inválido.');
      if (v.usado) return 'ya_verificado';
      if (enlaceVencido(v.fecha_expiracion)) {
        throw new RechazoAutenticacion('enlace_vencido', 'El enlace expiró. Solicite uno nuevo desde el inicio de sesión.', 'TOKEN_EXPIRADO');
      }
      await d.repositorio.confirmarCorreo(v.id, v.usuario_id);
      await d.auditoria.cuenta(visitante, 'EMAIL_VERIFICADO', { id: v.usuario_id, email: v.email });
      return 'verificado';
    },

    /**
     * Nuevo enlace de verificación (máximo uno por minuto). Nunca falla ni informa el resultado:
     * la respuesta es la misma exista o no la cuenta.
     */
    async reenviarVerificacion(email: unknown): Promise<void> {
      try {
        const u = await d.repositorio.porEmail(normalizarCorreo(email));
        if (!u || u.email_verificado) return;
        if (await d.repositorio.enlaceReciente('verificacion', u.id)) return;
        const { token, hash } = d.tokens.generar();
        await d.repositorio.emitirEnlace('verificacion', u.id, hash, HORAS_VERIFICACION * 60);
        await d.correo.verificacionCuenta(u.email, u.nombre_completo, enlace('verificar-email', token), HORAS_VERIFICACION);
      } catch (e) {
        d.registrarFallo('reenviar verificación', e);
      }
    },

    /**
     * Enlace para restablecer la contraseña de una cuenta activa y sin bloqueo administrativo
     * (máximo uno por minuto). Nunca falla ni informa el resultado: no permite descubrir correos.
     */
    async olvidePassword(email: unknown, visitante: Visitante): Promise<void> {
      try {
        const u = await d.repositorio.porEmail(normalizarCorreo(email));
        if (!u || u.estado !== 'activo' || u.bloqueado) return;
        if (await d.repositorio.enlaceReciente('restablecimiento', u.id)) return;
        const { token, hash } = d.tokens.generar();
        await d.repositorio.emitirEnlace('restablecimiento', u.id, hash, MINUTOS_RESTABLECIMIENTO);
        await d.correo.restablecerPassword(u.email, u.nombre_completo, enlace('restablecer-password', token), MINUTOS_RESTABLECIMIENTO);
        await d.auditoria.cuenta(visitante, 'SOLICITUD_RESTABLECIMIENTO', { id: u.id, email: u.email });
      } catch (e) {
        d.registrarFallo('olvidé contraseña', e);
      }
    },

    /** Define la nueva contraseña con el token del enlace (también activa una cuenta creada por un administrador). */
    async restablecerPassword(entrada: unknown, visitante: Visitante): Promise<void> {
      const b = cuerpo(entrada);
      const token = String(b.token ?? '');
      if (!RE_TOKEN_ENLACE.test(token)) throw errorValidacion('Enlace inválido.');
      const password = validarPassword(b.password);
      if (!password.ok) throw errorValidacion(password.error);
      const t = await d.repositorio.buscarEnlace('restablecimiento', d.tokens.hash(token));
      if (!t || t.usado) throw errorValidacion('El enlace ya fue usado o no es válido. Solicite uno nuevo.');
      if (enlaceVencido(t.fecha_expiracion)) throw new RechazoAutenticacion('enlace_vencido', 'El enlace expiró. Solicite uno nuevo.');
      await d.repositorio.restablecerPassword(t.id, t.usuario_id, await d.claves.cifrar(password.valor));
      await d.correo.passwordCambiada(t.email, t.nombre_completo);
      await d.auditoria.cuenta(visitante, 'PASSWORD_RESTABLECIDA', { id: t.usuario_id, email: t.email });
    },

    /** Datos de la sesión vigente con los permisos del rol actual (el rol pudo cambiar desde el inicio de sesión). */
    async sesionActual(id: number) {
      const u = await d.repositorio.sesion(id);
      if (!u || u.estado !== 'activo') throw new RechazoAutenticacion('sesion_inactiva', 'La cuenta ya no está activa.');
      const rol = rolVigente(u.rol, u.id);
      return {
        id: u.id, email: u.email, username: u.email, nombre: u.nombre_completo, cargo: u.cargo,
        rol, rol_nombre: u.rol_nombre, permisos: permisosDe(rol),
        fecha_ultimo_acceso: u.fecha_ultimo_acceso, fecha_creacion: u.fecha_creacion,
      };
    },

    /** Nombre y cargo propios (el correo y el rol los gestiona el administrador). */
    async actualizarPerfil(entrada: unknown, actor: Actor): Promise<void> {
      const p = leerPerfil(cuerpo(entrada));
      if (!p.ok) throw errorValidacion(p.error);
      await d.repositorio.actualizarPerfil(actor.id, p.valor);
      await d.auditoria.cuenta(actor, 'PERFIL_ACTUALIZADO', { id: actor.id, email: actor.email });
    },

    /** Cambio de la contraseña propia con la contraseña actual; se avisa por correo al titular. */
    async cambiarPassword(entrada: unknown, actor: Actor): Promise<void> {
      const b = cuerpo(entrada);
      const actual = String(b.actual ?? '');
      const nueva = validarPassword(b.nueva);
      if (!nueva.ok) throw errorValidacion(nueva.error);
      if (actual === nueva.valor) throw errorValidacion('La nueva contraseña debe ser distinta de la actual.');
      const u = await d.repositorio.credenciales(actor.id);
      if (!u || !(await d.claves.comparar(actual, u.password_hash))) throw errorValidacion('La contraseña actual no es correcta.');
      await d.repositorio.cambiarPassword(u.id, await d.claves.cifrar(nueva.valor));
      await d.correo.passwordCambiada(u.email, u.nombre_completo);
      await d.auditoria.cuenta(actor, 'PASSWORD_CAMBIADA', { id: u.id, email: u.email });
    },
  };
}

export type CasosAuth = ReturnType<typeof casosAuth>;
