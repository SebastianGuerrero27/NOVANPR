/**
 * Consulta de datos del propietario de un vehículo a partir de la placa.
 *
 * IMPORTANTE (marco legal, Ecuador):
 *  - Los datos del propietario son datos personales protegidos por la Ley Orgánica de
 *    Protección de Datos Personales (2021).
 *  - Los portales públicos (SRI, ANT) están diseñados para consultas individuales y
 *    protegidos con CAPTCHA; extraer sus datos de forma automatizada no está permitido.
 *  - El canal legítimo es un convenio institucional del ECU 911 con el Sistema Nacional de
 *    Registro de Datos Públicos (DINARDAP) o la ANT, que entrega un servicio web oficial.
 *
 * Este módulo es el PUNTO DE INTEGRACIÓN para ese servicio oficial: define la interfaz, deja
 * el proveedor deshabilitado por defecto y la ruta que lo usa (interfaz/http/rutas/propietario.ts) exige
 * rol Admin, motivo obligatorio, límite de consultas y auditoría de cada consulta.
 * Cuando exista el convenio, implemente `ProveedorServicioOficial.consultar` según la
 * especificación técnica entregada por la institución y active PROPIETARIO_PROVEEDOR=oficial.
 */

// Contrato del servicio (puerto de los casos de uso de propietario)
import type { DatosPropietario, ProveedorPropietario } from '../../aplicacion/propietario';

export type { DatosPropietario, ProveedorPropietario };

class ProveedorDeshabilitado implements ProveedorPropietario {
  readonly nombre = 'deshabilitado';
  readonly habilitado = false;
  async consultar(): Promise<DatosPropietario | null> {
    return null;
  }
}

/**
 * Adaptador para el servicio web oficial (DINARDAP / ANT) bajo convenio.
 * Pendiente de implementar con la especificación oficial (endpoint, autenticación, formato).
 */
class ProveedorServicioOficial implements ProveedorPropietario {
  readonly nombre = 'oficial';
  readonly habilitado: boolean;

  constructor(private readonly url = process.env.PROPIETARIO_API_URL ?? '', private readonly credencial = process.env.PROPIETARIO_API_CREDENCIAL ?? '') {
    this.habilitado = Boolean(this.url && this.credencial);
  }

  async consultar(_placa: string): Promise<DatosPropietario | null> {
    throw new Error(
      'El adaptador oficial aún no está implementado: requiere la especificación técnica del servicio web ' +
      'entregada por DINARDAP / ANT en el marco del convenio institucional.'
    );
  }
}

export function crearProveedorPropietario(): ProveedorPropietario {
  return process.env.PROPIETARIO_PROVEEDOR === 'oficial' ? new ProveedorServicioOficial() : new ProveedorDeshabilitado();
}

/** La identificación se enmascara con la regla del dominio. */
export { enmascararIdentificacion } from '../../dominio/propietario';
