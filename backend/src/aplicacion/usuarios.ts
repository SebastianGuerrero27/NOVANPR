import { type Actor, errorConflicto, errorNoEncontrado, errorProhibido, errorValidacion } from './comun';
import { NOMBRE_ROL, type Permiso, permisosDe, type Rol } from '../dominio/permisos';
import {
  type DatosEdicion, describirCambios, esAdministradorActivo, type EstadoCuenta, HORAS_CUENTA_NUEVA, leerAltaUsuario,
  leerEdicionUsuario, limiteAuditoria, MINUTOS_RESTABLECIMIENTO, pierdeAdministracion, REGLA_MOTIVO_BAJA, REGLA_MOTIVO_BLOQUEO,
} from '../dominio/usuarios';
import { validarTexto } from '../dominio/validacion';

/**
 * Casos de uso de la administración de cuentas (permiso usuarios:gestionar): consultar, ver el
 * detalle, crear, editar, bloquear, desbloquear, enviar el enlace de contraseña y dar de baja.
 *
 * Toda acción queda en AuditoriaUsuarios. Un cambio que afecta el acceso (rol, estado, bloqueo o
 * baja) invalida en el acto las sesiones de la cuenta, para que surta efecto en segundos y no
 * recién cuando vence el token. Ninguna acción puede dejar el sistema sin administrador activo.
 *
 * Aquí se declaran también los puertos que la autenticación (aplicacion/auth.ts) comparte:
 * auditoría de cuentas, correo, tokens de los enlaces y contraseñas.
 */

// ─── Puertos compartidos con la autenticación ────────────────────────────────

/** Visitante sin sesión (flujos públicos): su IP y su navegador quedan en la auditoría. */
export interface Visitante {
  ip: string | null;
  agente: string | null;
}

/** Quién origina una acción sobre una cuenta: una sesión (Actor) o un visitante sin sesión. */
export type Origen = Actor | Visitante;

/** Auditoría de cuentas, de solo inserción (AuditoriaUsuarios y AuditoriaAccesos). */
export interface PuertoAuditoriaCuentas {
  /** Acción sobre una cuenta; sin actor en los flujos públicos (registro, recuperación). */
  cuenta(origen: Origen, accion: string, objetivo: { id: number | null; email: string | null }, detalle?: string): Promise<void>;
  /** Intento de inicio de sesión con su resultado (ok, credenciales, bloqueado, no_verificado…). */
  acceso(visitante: Visitante, email: string, usuarioId: number | null, exito: boolean, motivo: string): Promise<void>;
}

/** Correos del ciclo de vida de la cuenta; cada envío devuelve si se concretó. */
export interface PuertoCorreoCuentas {
  smtpConfigurado(): boolean;
  verificacionCuenta(email: string, nombre: string, enlace: string, horas: number): Promise<boolean>;
  restablecerPassword(email: string, nombre: string, enlace: string, minutos: number): Promise<boolean>;
  definirPasswordCuentaNueva(email: string, nombre: string, enlace: string, horas: number, rol: string): Promise<boolean>;
  passwordCambiada(email: string, nombre: string): Promise<boolean>;
  cuentaBloqueada(email: string, nombre: string, minutos: number): Promise<boolean>;
}

/** Tokens de los enlaces de un solo uso: viajan en el correo y en la base se guarda solo su hash. */
export interface PuertoTokens {
  generar(): { token: string; hash: string };
  hash(token: string): string;
}

/** Contraseñas: solo se guarda un hash lento con sal (nunca la contraseña). */
export interface PuertoClaves {
  cifrar(password: string): Promise<string>;
  comparar(password: string, hash: string): Promise<boolean>;
  /** Comparación contra un hash ficticio: iguala el tiempo de respuesta cuando el correo no existe. */
  compararFicticio(password: string): Promise<void>;
  /** Hash de una clave aleatoria que nadie conoce (cuenta creada por un administrador). */
  inutilizable(): Promise<string>;
}

// ─── Administración de cuentas ───────────────────────────────────────────────

/** Cuenta tal como la entrega la API (el listado y el detalle tienen el mismo formato). */
export interface UsuarioDTO {
  id: number;
  email: string;
  nombre_completo: string;
  cargo: string | null;
  /** undefined si el código de rol guardado no es uno de los tres vigentes */
  rol?: Rol;
  rol_nombre: string;
  estado: EstadoCuenta;
  email_verificado: boolean;
  bloqueado: boolean;
  /** Fin del bloqueo temporal por intentos, solo mientras está vigente */
  bloqueo_temporal_hasta: Date | null;
  intentos_fallidos: number;
  fecha_ultimo_acceso: Date | null;
  fecha_creacion: Date;
  /** Correo de quien creó la cuenta (null en el registro público y en la configuración inicial) */
  creado_por: string | null;
}

export interface RolDTO {
  rol: Rol;
  nombre: string;
  descripcion: string | null;
  permisos: Permiso[];
}

export interface NuevaCuenta {
  email: string;
  nombre_completo: string;
  cargo: string | null;
  rol: Rol;
  passwordHash: string;
}

export interface RepositorioUsuarios {
  listar(): Promise<UsuarioDTO[]>;
  obtener(id: number): Promise<UsuarioDTO | null>;
  /** Catálogo de la tabla Roles; rol undefined si el código no es uno de los tres vigentes */
  roles(): Promise<{ rol?: Rol; nombre: string; descripcion: string | null }[]>;
  existeEmail(email: string): Promise<boolean>;
  /** Cuenta activa y con el correo verificado (la crea un administrador); devuelve el id */
  crear(c: NuevaCuenta, creadorId: number): Promise<number>;
  actualizar(id: number, c: DatosEdicion): Promise<void>;
  bloquear(id: number): Promise<void>;
  /** Quita el bloqueo administrativo y el temporal y reinicia los intentos fallidos */
  desbloquear(id: number): Promise<void>;
  /** Baja lógica: estado inactivo (la fila, su historial y su auditoría se conservan) */
  darDeBaja(id: number): Promise<void>;
  /** Cuentas que cumplen esAdministradorActivo() */
  contarAdministradoresActivos(): Promise<number>;
  /** Anula los enlaces de restablecimiento pendientes de la cuenta y guarda uno nuevo */
  emitirEnlaceRestablecimiento(usuarioId: number, tokenHash: string, minutos: number): Promise<void>;
  auditoria(limite: number): Promise<{ acciones: Record<string, unknown>[]; accesos: Record<string, unknown>[] }>;
}

export interface DependenciasUsuarios {
  repositorio: RepositorioUsuarios;
  auditoria: PuertoAuditoriaCuentas;
  correo: Pick<PuertoCorreoCuentas, 'definirPasswordCuentaNueva' | 'restablecerPassword'>;
  tokens: Pick<PuertoTokens, 'generar'>;
  claves: Pick<PuertoClaves, 'inutilizable'>;
  /** Invalida la caché de estado de la cuenta y cierra sus conexiones en tiempo real */
  invalidarSesiones: (usuarioId: number) => void;
  dominiosPermitidos: () => string[];
  /** URL pública del frontend (enlaces de los correos) */
  urlFrontend: () => string;
}

export function casosUsuarios(d: DependenciasUsuarios) {
  const enlaceRestablecimiento = (token: string) => `${d.urlFrontend()}/restablecer-password?token=${token}`;

  async function obtener(id: number): Promise<UsuarioDTO> {
    const u = await d.repositorio.obtener(id);
    if (!u) throw errorNoEncontrado('Usuario no encontrado.');
    return u;
  }

  /** Cuenta tal como quedó tras un cambio (la fila existe: se acaba de escribir). */
  const releer = async (id: number) => (await d.repositorio.obtener(id))!;

  /** ¿Queda al menos otro administrador activo además del afectado? */
  const quedaOtroAdministrador = async () => (await d.repositorio.contarAdministradoresActivos()) > 1;

  return {
    listar: () => d.repositorio.listar(),
    obtener,

    async roles(): Promise<RolDTO[]> {
      const roles: RolDTO[] = [];
      for (const r of await d.repositorio.roles()) {
        if (r.rol) roles.push({ rol: r.rol, nombre: r.nombre, descripcion: r.descripcion, permisos: permisosDe(r.rol) });
      }
      return roles;
    },

    async crear(entrada: unknown, actor: Actor) {
      const datos = leerAltaUsuario(entrada as Record<string, unknown>, d.dominiosPermitidos());
      if (!datos.ok) throw errorValidacion(datos.error);
      const c = datos.valor;
      if (await d.repositorio.existeEmail(c.email)) throw errorConflicto('Ya existe una cuenta con ese correo.');
      // Contraseña aleatoria inutilizable: la persona define la suya con el enlace (el administrador nunca la conoce)
      const id = await d.repositorio.crear({ ...c, passwordHash: await d.claves.inutilizable() }, actor.id);
      const { token, hash } = d.tokens.generar();
      await d.repositorio.emitirEnlaceRestablecimiento(id, hash, HORAS_CUENTA_NUEVA * 60);
      const enviado = await d.correo.definirPasswordCuentaNueva(
        c.email, c.nombre_completo, enlaceRestablecimiento(token), HORAS_CUENTA_NUEVA, NOMBRE_ROL[c.rol]);
      await d.auditoria.cuenta(actor, 'USUARIO_CREADO', { id, email: c.email }, `Rol ${c.rol}`);
      return { usuario: await releer(id), enviado };
    },

    async editar(id: number, entrada: unknown, actor: Actor) {
      const actual = await obtener(id);
      const datos = leerEdicionUsuario(entrada as Record<string, unknown>, actual);
      if (!datos.ok) throw errorValidacion(datos.error);
      const nuevo = datos.valor;
      // Estas dos reglas responden 400 (no 403/409): es el contrato que ya usa el cliente
      if (pierdeAdministracion(actual, nuevo)) {
        if (id === actor.id) throw errorValidacion('No puede quitarse a sí mismo el rol de administrador ni desactivarse.');
        if (!(await quedaOtroAdministrador())) throw errorValidacion('Debe existir al menos un administrador activo.');
      }
      await d.repositorio.actualizar(id, nuevo);
      d.invalidarSesiones(id);
      await d.auditoria.cuenta(actor, 'USUARIO_ACTUALIZADO', { id, email: actual.email }, describirCambios(actual, nuevo));
      return releer(id);
    },

    async bloquear(id: number, motivo: unknown, actor: Actor) {
      const u = await obtener(id);
      // Mismo orden y mismos 400 que el contrato vigente
      if (id === actor.id) throw errorValidacion('No puede bloquear su propia cuenta.');
      if (u.rol === 'Admin' && !(await quedaOtroAdministrador())) throw errorValidacion('Debe existir al menos un administrador activo.');
      // El motivo sigue siendo opcional; si llega, se valida como texto libre (sin < >, hasta 300)
      const m = validarTexto(motivo, REGLA_MOTIVO_BLOQUEO);
      if (!m.ok) throw errorValidacion(m.error);
      await d.repositorio.bloquear(id);
      d.invalidarSesiones(id);
      await d.auditoria.cuenta(actor, 'USUARIO_BLOQUEADO', { id, email: u.email }, m.valor ?? undefined);
      return releer(id);
    },

    async desbloquear(id: number, actor: Actor) {
      const u = await obtener(id);
      await d.repositorio.desbloquear(id);
      d.invalidarSesiones(id);
      await d.auditoria.cuenta(actor, 'USUARIO_DESBLOQUEADO', { id, email: u.email });
      return releer(id);
    },

    /** Enlace de restablecimiento enviado por el administrador; devuelve si el correo salió. */
    async enviarEnlacePassword(id: number, actor: Actor) {
      const u = await obtener(id);
      const { token, hash } = d.tokens.generar();
      await d.repositorio.emitirEnlaceRestablecimiento(id, hash, MINUTOS_RESTABLECIMIENTO);
      const enviado = await d.correo.restablecerPassword(u.email, u.nombre_completo, enlaceRestablecimiento(token), MINUTOS_RESTABLECIMIENTO);
      await d.auditoria.cuenta(actor, 'ENLACE_PASSWORD_ENVIADO', { id, email: u.email });
      return enviado;
    },

    /**
     * Baja lógica: la cuenta queda inactiva (no puede iniciar sesión y sus sesiones se cierran en
     * segundos, igual que al desactivarla desde la edición) y se conservan su historial y su
     * auditoría. Exige motivo; nadie puede darse de baja a sí mismo ni dejar el sistema sin
     * administrador activo. Se revierte editando el estado a activo.
     */
    async darDeBaja(id: number, motivo: unknown, actor: Actor) {
      if (id === actor.id) throw errorProhibido('No puede dar de baja su propia cuenta.');
      const m = validarTexto(motivo, REGLA_MOTIVO_BAJA);
      if (!m.ok) throw errorValidacion(m.error);
      const u = await obtener(id);
      if (u.estado === 'inactivo') throw errorConflicto('La cuenta ya está dada de baja.');
      if (esAdministradorActivo(u) && !(await quedaOtroAdministrador())) {
        throw errorConflicto('No se puede dar de baja al único administrador activo: el sistema debe conservar al menos uno.');
      }
      await d.repositorio.darDeBaja(id);
      d.invalidarSesiones(id);
      await d.auditoria.cuenta(actor, 'USUARIO_DADO_DE_BAJA', { id, email: u.email }, `estado ${u.estado} → inactivo · ${m.valor}`);
      return releer(id);
    },

    auditoria: (limite: unknown) => d.repositorio.auditoria(limiteAuditoria(limite)),
  };
}

export type CasosUsuarios = ReturnType<typeof casosUsuarios>;
