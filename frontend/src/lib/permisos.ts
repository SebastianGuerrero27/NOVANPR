/**
 * Permisos de la sesión (espejo de backend/src/dominio/permisos.ts).
 *
 * La fuente de verdad es el backend: /api/auth/me entrega los permisos del rol y la interfaz
 * solo los consulta (`puede`). Este archivo declara los nombres para el tipado y las etiquetas
 * que se muestran en el perfil; la API vuelve a verificar cada permiso en cada solicitud.
 */

export type Rol = 'Admin' | 'Supervisor' | 'Operador' | 'GestorAccesos';

export const ROLES_ORDEN: Rol[] = ['Operador', 'GestorAccesos', 'Supervisor', 'Admin'];

export type Permiso =
  | 'operacion:monitorear' | 'detecciones:validar' | 'detecciones:eliminar'
  | 'listas:ver' | 'padron:gestionar' | 'alertas:gestionar' | 'accesos:excepcion'
  | 'solicitudes:crear' | 'solicitudes:resolver'
  | 'avisos:garita' | 'avisos:acceso' | 'avisos:seguridad' | 'avisos:sistema' | 'alarmas:escalamiento'
  | 'reportes:ver' | 'evaluacion:ver'
  | 'camaras:operar' | 'camaras:gestionar' | 'usuarios:gestionar' | 'auditoria:ver' | 'configuracion:gestionar'
  | 'propietario:consultar';

export const ETIQUETA_PERMISO: Record<Permiso, string> = {
  'operacion:monitorear': 'Monitoreo en vivo, panel de inicio y registro de ingresos',
  'detecciones:validar': 'Confirmar o corregir lecturas y registrar ingresos manuales',
  'detecciones:eliminar': 'Eliminar ingresos y su evidencia',
  'listas:ver': 'Consultar el padrón de autorizados y la lista de alertas',
  'padron:gestionar': 'Gestionar permisos de placa: vigencia, horarios y categoría',
  'alertas:gestionar': 'Gestionar la lista de alertas',
  'accesos:excepcion': 'Autorizar ingresos por excepción (fuera de horario o vigencia)',
  'solicitudes:crear': 'Solicitar la autorización de una placa',
  'solicitudes:resolver': 'Aprobar o rechazar solicitudes de acceso',
  'avisos:garita': 'Aviso a pantalla completa con protocolo en el punto de control',
  'avisos:acceso': 'Notificaciones de accesos denegados y fuera de horario',
  'avisos:seguridad': 'Notificaciones de placas con alerta y posibles placas clonadas',
  'avisos:sistema': 'Notificaciones de cámaras sin conexión',
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
  Operador: 'Monitorea el acceso en tiempo real, valida lecturas, registra ingresos manuales y solicita autorizaciones.',
  GestorAccesos: 'Administra los permisos de ingreso de placas (vigencia, horarios y categoría), resuelve las solicitudes de acceso y recibe las alertas de accesos denegados.',
  Supervisor: 'Gestiona las listas de control, consulta reportes y la evaluación, recibe alarmas escaladas y cambia la cámara del motor.',
  Admin: 'Control total: usuarios, cámaras, configuración, auditoría y todas las funciones operativas.',
};
