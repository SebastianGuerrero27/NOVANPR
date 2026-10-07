/**
 * Permisos de la sesión (espejo de backend/src/dominio/permisos.ts).
 *
 * La fuente de verdad es el backend: /api/auth/me entrega los permisos del rol y la interfaz
 * solo los consulta (`puede`). Este archivo declara los nombres para el tipado y las etiquetas
 * que se muestran en el perfil; la API vuelve a verificar cada permiso en cada solicitud.
 */

export type Rol = 'Admin' | 'Guardia' | 'GestorPermisos';

export const ROLES_ORDEN: Rol[] = ['Guardia', 'GestorPermisos', 'Admin'];

export type Permiso =
  | 'operacion:monitorear' | 'detecciones:validar' | 'detecciones:eliminar'
  | 'listas:ver' | 'padron:gestionar' | 'alertas:gestionar' | 'accesos:excepcion'
  | 'solicitudes:crear' | 'solicitudes:resolver'
  | 'avisos:garita' | 'avisos:acceso' | 'avisos:seguridad' | 'avisos:sistema' | 'avisos:padron' | 'alarmas:escalamiento'
  | 'reportes:ver' | 'evaluacion:ver'
  | 'camaras:operar' | 'camaras:gestionar' | 'usuarios:gestionar' | 'auditoria:ver' | 'configuracion:gestionar'
  | 'propietario:consultar';

/**
 * Vista única del gestor de permisos: quien gestiona el padrón sin permisos de operación trabaja en
 * una sola pantalla (permisos de placa y solicitudes), sin monitoreo en vivo ni registro de ingresos.
 */
export function esVistaGestionPermisos(puede: (p: Permiso) => boolean): boolean {
  return puede('padron:gestionar') && !puede('operacion:monitorear');
}

export const ETIQUETA_PERMISO: Record<Permiso, string> = {
  'operacion:monitorear': 'Monitoreo en vivo, panel de inicio y registro de ingresos',
  'detecciones:validar': 'Confirmar o corregir lecturas y registrar ingresos manuales',
  'detecciones:eliminar': 'Eliminar ingresos y su evidencia',
  'listas:ver': 'Consultar la lista blanca y la lista negra',
  'padron:gestionar': 'Registrar vehículos en la lista blanca: vigencia, horarios y categoría',
  'alertas:gestionar': 'Registrar placas en la lista negra',
  'accesos:excepcion': 'Autorizar ingresos por excepción (fuera de horario o vigencia)',
  'solicitudes:crear': 'Solicitar la autorización de una placa',
  'solicitudes:resolver': 'Aprobar o rechazar solicitudes de acceso',
  'avisos:garita': 'Aviso a pantalla completa con protocolo en el punto de control',
  'avisos:acceso': 'Notificaciones de accesos denegados y fuera de horario',
  'avisos:seguridad': 'Notificaciones de placas de la lista negra y posibles placas clonadas',
  'avisos:sistema': 'Notificaciones de cámaras sin conexión',
  'avisos:padron': 'Notificaciones de vehículos agregados a la lista blanca',
  'alarmas:escalamiento': 'Alarmas no atendidas escaladas',
  'reportes:ver': 'Reportes por período y cámara',
  'evaluacion:ver': 'Evaluación científica del reconocimiento',
  'camaras:operar': 'Cambiar la cámara del motor y su región de interés',
  'camaras:gestionar': 'Alta y diagnóstico de cámaras',
  'usuarios:gestionar': 'Cuentas, roles y bloqueos del personal',
  'auditoria:ver': 'Consultar la auditoría',
  'configuracion:gestionar': 'Parámetros del sistema',
  'propietario:consultar': 'Consulta del propietario de una placa',
};

export const DESCRIPCION_ROL: Record<Rol, string> = {
  Guardia: 'Monitorea el punto de control en tiempo real, valida lecturas, consulta la lista blanca y solicita autorizaciones. Recibe la notificación de cada permiso otorgado.',
  GestorPermisos: 'Registra y administra la lista blanca de vehículos autorizados y resuelve las solicitudes de acceso desde una sola vista, sin monitoreo en vivo. Solo se le notifica la llegada de los vehículos a los que dio permiso.',
  Admin: 'Control total: usuarios, cámaras, configuración, auditoría, lista negra y todas las funciones operativas.',
};
