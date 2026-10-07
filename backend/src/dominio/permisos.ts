/**
 * Control de acceso basado en roles (RBAC, modelo NIST / ANSI INCITS 359-2004).
 *
 *   usuario ──(1 rol)──▶ rol ──(n permisos)──▶ permiso
 *
 * La matriz rol → permiso de este archivo es la ÚNICA fuente de verdad: los endpoints exigen
 * permisos (`requierePermiso`) en lugar de listas de roles repartidas por el código, y el
 * frontend recibe los permisos de la sesión en /api/auth/me para armar el menú y las acciones.
 * Agregar un rol o mover una capacidad es un cambio de una línea, auditable y probado
 * (src/tests/dominio/permisos.test.ts).
 *
 * Roles: Administrador, Guardia y Gestor de permisos.
 *
 * Separación de funciones (SoD): quien solicita el acceso de una placa no puede resolver esa
 * misma solicitud (regla dinámica aplicada en aplicacion/solicitudesAcceso.ts con un reclamo
 * atómico en el repositorio).
 */

export const ROLES = ['Admin', 'Guardia', 'GestorPermisos'] as const;
export type Rol = typeof ROLES[number];

/** Código de la tabla Roles ↔ rol de la aplicación. */
export const ROL_POR_CODIGO: Record<string, Rol> = {
  ADMIN: 'Admin', GUARDIA: 'Guardia', GESTOR_PERMISOS: 'GestorPermisos',
};
export const CODIGO_POR_ROL: Record<Rol, string> = {
  Admin: 'ADMIN', Guardia: 'GUARDIA', GestorPermisos: 'GESTOR_PERMISOS',
};

export const NOMBRE_ROL: Record<Rol, string> = {
  Admin: 'Administrador', Guardia: 'Guardia', GestorPermisos: 'Gestor de permisos',
};

/** Catálogo de permisos (recurso:acción). */
export const PERMISOS = {
  // Operación
  'operacion:monitorear': 'Ver el monitoreo en vivo, el panel de inicio y el registro de ingresos',
  'detecciones:validar': 'Confirmar o corregir lecturas y registrar ingresos manuales',
  'detecciones:eliminar': 'Eliminar ingresos y su evidencia',
  // Listas de control
  'listas:ver': 'Consultar el padrón de autorizados y la lista de alertas',
  'padron:gestionar': 'Alta, edición y retiro de permisos de placa (vigencias, horarios, categoría)',
  'alertas:gestionar': 'Alta, edición y retiro de placas en la lista de alertas',
  'accesos:excepcion': 'Autorizar excepcionalmente un ingreso fuera del horario o la vigencia del permiso',
  // Solicitudes de acceso
  'solicitudes:crear': 'Solicitar la autorización de una placa',
  'solicitudes:resolver': 'Aprobar o rechazar solicitudes de acceso',
  // Avisos y notificaciones (enrutamiento de notificaciones por permiso)
  'avisos:garita': 'Aviso a pantalla completa con protocolo en el punto de control',
  'avisos:acceso': 'Notificaciones de accesos denegados, fuera de horario y confirmaciones',
  'avisos:seguridad': 'Notificaciones de placas en la lista de alertas y posibles placas clonadas',
  'avisos:sistema': 'Notificaciones de cámaras sin conexión y del estado del servicio',
  'avisos:padron': 'Notificaciones de permisos de placa otorgados (lista blanca)',
  'alarmas:escalamiento': 'Recibir alarmas no atendidas escaladas',
  // Análisis
  'reportes:ver': 'Reportes por período y cámara',
  'evaluacion:ver': 'Métricas científicas del reconocimiento',
  // Infraestructura y administración
  'camaras:operar': 'Cambiar la cámara que procesa el motor y su región de interés',
  'camaras:gestionar': 'Alta, edición y diagnóstico de cámaras',
  'usuarios:gestionar': 'Cuentas, roles y bloqueos del personal',
  'auditoria:ver': 'Consultar la auditoría',
  'configuracion:gestionar': 'Parámetros del sistema',
  'propietario:consultar': 'Consulta del propietario de una placa (convenio)',
} as const;

export type Permiso = keyof typeof PERMISOS;

/** Matriz rol → permisos. */
export const MATRIZ: Record<Rol, readonly Permiso[]> = {
  // Punto de control: monitorea, valida lecturas, consulta la lista blanca y solicita accesos.
  // Recibe los avisos de garita y la notificación de cada permiso otorgado.
  Guardia: [
    'operacion:monitorear', 'detecciones:validar', 'listas:ver', 'solicitudes:crear',
    'avisos:garita', 'avisos:acceso', 'avisos:seguridad', 'avisos:padron',
  ],
  // Una sola vista (gestión de permisos), sin monitoreo: concede permisos de placa y resuelve
  // solicitudes. Solo se le notifica la llegada de los vehículos a los que dio permiso
  // (destinatario explícito, ver infraestructura/servicios/avisosAcceso.ts), no los avisos de monitoreo.
  GestorPermisos: [
    'listas:ver', 'padron:gestionar', 'solicitudes:resolver',
  ],
  Admin: Object.keys(PERMISOS) as Permiso[],
};

const INDICE = {} as Record<Rol, ReadonlySet<Permiso>>;
for (const r of ROLES) INDICE[r] = new Set(MATRIZ[r]);

export function esRol(valor: unknown): valor is Rol {
  return typeof valor === 'string' && (ROLES as readonly string[]).includes(valor);
}

export function tienePermiso(rol: Rol | undefined | null, permiso: Permiso): boolean {
  return !!rol && !!INDICE[rol]?.has(permiso);
}

export function permisosDe(rol: Rol): Permiso[] {
  return [...MATRIZ[rol]];
}

/** Roles que tienen un permiso (enrutamiento de notificaciones). */
export function rolesCon(permiso: Permiso): Rol[] {
  return ROLES.filter(r => INDICE[r].has(permiso));
}
