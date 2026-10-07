import { getDB } from '../db';
import type { RepositorioConfiguracion } from '../../aplicacion/configuracion';
import { cargarConfiguracion, DEFINICIONES, guardarValor, listarConfiguracion } from '../servicios/configuracion';

/**
 * Repositorio de la configuración del sistema (tabla ConfiguracionSistema). Envuelve el adaptador
 * infraestructura/servicios/configuracion.ts, que además mantiene los valores en memoria para las lecturas
 * síncronas del resto del sistema (inicio de sesión, registro, decisión de acceso).
 */
export const repositorioConfiguracionSql: RepositorioConfiguracion = {
  definiciones: () => DEFINICIONES,
  listar: () => listarConfiguracion(),
  guardar: (clave, valor, usuarioId) => guardarValor(getDB(), clave, valor, usuarioId),
  recargar: () => cargarConfiguracion(getDB()),
};
