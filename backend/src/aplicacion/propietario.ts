import { type Actor, ErrorAplicacion, errorLimite, errorNoDisponible, errorNoEncontrado, errorValidacion } from './comun';
import { enmascararIdentificacion, leerConsultaPropietario } from '../dominio/propietario';

/**
 * Consulta del propietario de una placa (propietario:consultar) y su auditoría.
 *
 * Orden de las reglas: datos válidos (400), cupo de consultas por hora del usuario (429),
 * servicio oficial habilitado (503) y respuesta del proveedor (404 si no hay datos). TODA consulta
 * válida queda registrada con su resultado, incluidas las rechazadas y las fallidas.
 */

/** Datos que entrega el servicio oficial (DINARDAP / ANT). */
export interface DatosPropietario {
  nombre: string;
  /** Se enmascara en la respuesta (p. ej. 18XXXXXX45) */
  identificacion?: string;
  marca?: string;
  modelo?: string;
  color?: string;
  anio?: number;
  /** Institución que respondió */
  fuente: string;
}

/** Servicio oficial de consulta (infraestructura/servicios/consultaPropietario.ts). */
export interface ProveedorPropietario {
  readonly nombre: string;
  readonly habilitado: boolean;
  consultar(placa: string): Promise<DatosPropietario | null>;
}

export type ResultadoConsulta = 'ok' | 'no_encontrado' | 'limite' | 'deshabilitado' | 'error';

export interface RegistroConsulta {
  actor: Actor;
  placa: string;
  motivo: string;
  deteccionId: number | null;
  proveedor: string;
  resultado: ResultadoConsulta;
}

export interface RepositorioPropietario {
  /** Consultas del usuario en la última hora (cupo) */
  consultasUltimaHora(usuarioId: number): Promise<number>;
  registrar(c: RegistroConsulta): Promise<void>;
  /** Las 200 consultas más recientes */
  recientes(): Promise<Record<string, unknown>[]>;
}

export interface DependenciasPropietario {
  repositorio: RepositorioPropietario;
  proveedor: ProveedorPropietario;
  limitePorHora: number;
}

export const MENSAJE_DESHABILITADO =
  'La consulta de propietarios no está habilitada. Requiere un convenio del ECU 911 con DINARDAP / ANT ' +
  'para acceder a su servicio web oficial; la extracción automatizada de portales públicos (SRI, ANT) no está permitida.';

export function casosPropietario(d: DependenciasPropietario) {
  return {
    async consultar(entrada: unknown, actor: Actor) {
      const c = leerConsultaPropietario(entrada);
      if (!c.ok) throw errorValidacion(c.error);
      const { placa, motivo, deteccionId } = c.valor;
      const registrar = (resultado: ResultadoConsulta) =>
        d.repositorio.registrar({ actor, placa, motivo, deteccionId, proveedor: d.proveedor.nombre, resultado });

      try {
        if ((await d.repositorio.consultasUltimaHora(actor.id)) >= d.limitePorHora) {
          await registrar('limite');
          throw errorLimite(`Límite de ${d.limitePorHora} consultas por hora alcanzado.`);
        }
        if (!d.proveedor.habilitado) {
          await registrar('deshabilitado');
          throw errorNoDisponible(MENSAJE_DESHABILITADO);
        }
        const datos = await d.proveedor.consultar(placa);
        await registrar(datos ? 'ok' : 'no_encontrado');
        if (!datos) throw errorNoEncontrado('No se encontraron datos para la placa.');
        return { placa, ...datos, identificacion: enmascararIdentificacion(datos.identificacion) };
      } catch (e) {
        if (e instanceof ErrorAplicacion) throw e;
        // Falla del proveedor o de la base: también queda registrada (sin ocultar el error original)
        try { await registrar('error'); } catch { /* la auditoría no debe ocultar el error original */ }
        throw e;
      }
    },

    async auditoria() {
      return { proveedor: d.proveedor.nombre, habilitado: d.proveedor.habilitado, consultas: await d.repositorio.recientes() };
    },
  };
}

export type CasosPropietario = ReturnType<typeof casosPropietario>;
