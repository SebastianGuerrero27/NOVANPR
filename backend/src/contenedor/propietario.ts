import { casosPropietario } from '../aplicacion/propietario';
import { repositorioPropietarioSql } from '../infraestructura/persistencia/propietarioSql';
import { crearProveedorPropietario } from '../infraestructura/servicios/consultaPropietario';

/** Raíz de composición de la consulta de propietario: servicio oficial (si hay convenio) y auditoría en SQL Server. */
export const propietario = casosPropietario({
  repositorio: repositorioPropietarioSql,
  proveedor: crearProveedorPropietario(),
  limitePorHora: Number(process.env.PROPIETARIO_LIMITE_HORA ?? 20),
});
