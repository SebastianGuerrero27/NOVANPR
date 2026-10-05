/**
 * Elementos comunes de la capa de aplicación (casos de uso).
 *
 * Arquitectura limpia (Martin, 2017): las dependencias apuntan hacia adentro.
 *
 *   interfaz/http  ──▶  aplicacion (casos de uso + puertos)  ──▶  dominio (reglas puras)
 *         │                        ▲
 *         └──── infraestructura ───┘  (implementa los puertos: SQL Server, Socket.IO, correo…)
 *
 * Un caso de uso no conoce Express ni mssql: recibe datos ya interpretados, el actor que lo
 * ejecuta y los puertos que necesita, y comunica los fallos con ErrorAplicacion. La capa HTTP
 * traduce cada tipo de error a su código de estado (interfaz/http/respuesta.ts).
 */

/**
 * validacion 400 · no_encontrado 404 · conflicto 409 · prohibido 403 · limite 429 (cupo de uso
 * agotado) · no_disponible 503 (servicio deshabilitado o sin configurar en el servidor).
 */
export type TipoError = 'validacion' | 'no_encontrado' | 'conflicto' | 'prohibido' | 'limite' | 'no_disponible';

export class ErrorAplicacion extends Error {
  constructor(readonly tipo: TipoError, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorAplicacion';
  }
}

export const errorValidacion = (m: string) => new ErrorAplicacion('validacion', m);
export const errorNoEncontrado = (m: string) => new ErrorAplicacion('no_encontrado', m);
export const errorConflicto = (m: string) => new ErrorAplicacion('conflicto', m);
export const errorProhibido = (m: string) => new ErrorAplicacion('prohibido', m);
export const errorLimite = (m: string) => new ErrorAplicacion('limite', m);
export const errorNoDisponible = (m: string) => new ErrorAplicacion('no_disponible', m);

/** Quién ejecuta el caso de uso (para autorización fina y auditoría). */
export interface Actor {
  id: number;
  email: string;
  nombre: string;
  rol: string;
  ip: string | null;
}

/** Puerto de auditoría de operaciones (registro inmutable, ver infraestructura/auditoriaSql.ts). */
export interface PuertoAuditoria {
  operacion(actor: Actor, accion: string, entidad: string, entidadId: number | null, detalle?: string): Promise<void>;
}

/** Puerto de eventos en tiempo real hacia los clientes conectados. */
export interface PuertoEventos {
  emitir(evento: string, datos: unknown): void;
}
