import type { CampoDoc, RutaDoc } from './openapi';

/**
 * Catálogo de rutas de la API para la documentación OpenAPI (interfaz/http/docs/openapi.ts).
 *
 * Cada entrada corresponde a un `router.<método>(ruta)` montado en app.ts (MONTAJES): la ruta
 * es el prefijo del montaje más el patrón exacto de Express, y el acceso refleja los
 * middlewares aplicados (authMiddleware, servicioMiddleware, requierePermiso). La prueba
 * tests/docs/openapi.test.ts compara este catálogo con las rutas registradas.
 */

// ─── Campos reutilizados ────────────────────────────────────────────────────

const PAGINACION: Record<string, CampoDoc> = {
  pagina: { tipo: 'integer', descripcion: 'Página (desde 1)', ejemplo: 1 },
  tamano: { tipo: 'integer', descripcion: 'Registros por página', ejemplo: 25 },
};

/** Filtros comunes del historial de detecciones, su exportación y la eliminación masiva. */
const FILTROS_DETECCIONES: Record<string, CampoDoc> = {
  placa: { tipo: 'string', descripcion: 'Placa o parte de ella', ejemplo: 'PBA1234' },
  estado: {
    tipo: 'string',
    descripcion: 'Estados separados por coma: autorizado, alerta, no_reconocido, pendiente_revision',
    ejemplo: 'alerta,no_reconocido',
  },
  camara: { tipo: 'integer', descripcion: 'ID de la cámara', ejemplo: 1 },
  validado: { tipo: 'string', descripcion: 'Validado por el operador', valores: ['si', 'no'] },
  desde: { tipo: 'string', formato: 'date-time', descripcion: 'Fecha y hora inicial', ejemplo: '2026-10-01T00:00:00' },
  hasta: { tipo: 'string', formato: 'date-time', descripcion: 'Fecha y hora final', ejemplo: '2026-10-01T23:59:59' },
};

/** Reglas en dominio/camaras.ts (alfanumérico: letras, números, espacios y . , / # ( ) -). */
const CAMARA: Record<string, CampoDoc> = {
  nombre: { tipo: 'string', descripcion: 'Nombre alfanumérico (3 a 100 caracteres)', requerido: true, ejemplo: 'Garita principal - entrada' },
  ubicacion: { tipo: 'string', descripcion: 'Ubicación alfanumérica (3 a 150 caracteres)', requerido: true, ejemplo: 'Acceso norte, Samborondón' },
  rtsp_url: {
    tipo: 'string',
    descripcion: 'URL rtsp:// o rtsps:// (máx. 255, sin espacios); si llega enmascarada (******) se conserva la contraseña guardada',
    requerido: true, ejemplo: 'rtsp://admin:clave@192.168.1.64:554/Streaming/Channels/101',
  },
  ip: { tipo: 'string', descripcion: 'IPv4 o nombre de host para el ping (máx. 45); por omisión, el host de la URL', ejemplo: '192.168.1.64' },
};

/** Cámara registrada cuya contraseña se recupera si la URL llega enmascarada (Ping o Play del formulario). */
const CAMARA_PRUEBA: CampoDoc = {
  tipo: 'integer', descripcion: 'Cámara registrada (entero positivo), para recuperar la contraseña si la URL llega enmascarada', ejemplo: 1,
};

const VEHICULO: Record<string, CampoDoc> = {
  marca: { tipo: 'string', descripcion: 'Marca (máx. 50)', ejemplo: 'Chevrolet' },
  modelo: { tipo: 'string', descripcion: 'Modelo (máx. 50)', ejemplo: 'Aveo' },
  color: { tipo: 'string', descripcion: 'Color (máx. 30)', ejemplo: 'Blanco' },
  observaciones: { tipo: 'string', descripcion: 'Observaciones (máx. 255)' },
};

const PLACA_LISTA: CampoDoc = { tipo: 'string', descripcion: 'Placa (4 a 10 letras y números)', requerido: true, ejemplo: 'PBA1234' };
const HORARIO: CampoDoc = {
  tipo: 'array',
  descripcion: 'Lista de franjas { dias (1 = lunes … 7 = domingo), desde, hasta (HH:MM) }; null = sin restricción horaria',
  ejemplo: [{ dias: [1, 2, 3, 4, 5], desde: '07:00', hasta: '18:00' }],
};
const CATEGORIAS = ['FUNCIONARIO', 'VISITANTE', 'PROVEEDOR', 'CONTRATISTA', 'OFICIAL', 'EMERGENCIA'];

const CUERPO_AUTORIZADO: Record<string, CampoDoc> = {
  placa: PLACA_LISTA,
  propietario: { tipo: 'string', descripcion: 'Propietario o responsable (máx. 150)', requerido: true, ejemplo: 'Juan Pérez' },
  departamento: { tipo: 'string', descripcion: 'Departamento (máx. 100)', ejemplo: 'Sala de operaciones' },
  categoria: { tipo: 'string', descripcion: 'Categoría del permiso (por omisión FUNCIONARIO)', valores: CATEGORIAS },
  tipo_vehiculo: { tipo: 'string', descripcion: 'Tipo de vehículo (máx. 50)', ejemplo: 'Automóvil' },
  ...VEHICULO,
  fecha_inicio: { tipo: 'string', formato: 'date', descripcion: 'Inicio de vigencia (AAAA-MM-DD)', ejemplo: '2026-10-01' },
  fecha_vencimiento: { tipo: 'string', formato: 'date', descripcion: 'Fin de vigencia (AAAA-MM-DD)', ejemplo: '2026-12-31' },
  horario: HORARIO,
};

const CUERPO_ALERTA: Record<string, CampoDoc> = {
  placa: PLACA_LISTA,
  motivo: { tipo: 'string', descripcion: 'Motivo de la alerta (máx. 255)', requerido: true, ejemplo: 'Vehículo reportado como robado' },
  nivel_alerta: { tipo: 'string', descripcion: 'Nivel de la alerta', requerido: true, valores: ['CRITICA', 'ALTA', 'MEDIA'] },
  ...VEHICULO,
  fecha_vencimiento: { tipo: 'string', formato: 'date', descripcion: 'Fin de vigencia de la alerta (AAAA-MM-DD)', ejemplo: '2026-12-31' },
};

/** Alta y edición de una solicitud de acceso: reglas de la lista blanca más el motivo (dominio/solicitudesAcceso.ts). */
const CUERPO_SOLICITUD: Record<string, CampoDoc> = {
  placa: { tipo: 'string', descripcion: 'ABC-1234 (automóvil) o AB-123C (motocicleta), con o sin guion', requerido: true, ejemplo: 'PBA-1234' },
  propietario: { tipo: 'string', requerido: true, descripcion: 'Conductor o responsable: letras, espacios y . \' - & (3 a 150)', ejemplo: 'Ana Villacís' },
  motivo: { tipo: 'string', requerido: true, descripcion: 'Texto libre sin < > (5 a 300 caracteres)', ejemplo: 'Visita técnica al centro de datos' },
  departamento: { tipo: 'string', descripcion: 'Unidad que visita (máx. 100)', ejemplo: 'Tecnología' },
  categoria: { tipo: 'string', valores: CATEGORIAS, descripcion: 'Por omisión VISITANTE' },
  tipo_vehiculo: { tipo: 'string', descripcion: 'Tipo de vehículo (máx. 50)', ejemplo: 'Automóvil' },
  marca: VEHICULO.marca,
  modelo: VEHICULO.modelo,
  color: VEHICULO.color,
  fecha_inicio: { tipo: 'string', formato: 'date', descripcion: 'Inicio de vigencia (AAAA-MM-DD)', ejemplo: '2026-10-05' },
  fecha_fin: { tipo: 'string', formato: 'date', descripcion: 'Fin de vigencia (AAAA-MM-DD), no anterior al inicio', ejemplo: '2026-10-05' },
  horario: HORARIO,
  deteccion_id: { tipo: 'integer', descripcion: 'Paso vehicular que originó la solicitud (entero positivo o null)', ejemplo: 1532 },
};

/** Filtros comunes de la consulta y la exportación de la auditoría (dominio/auditoria.ts). */
const FILTROS_AUDITORIA: Record<string, CampoDoc> = {
  fuente: { tipo: 'string', valores: ['operaciones', 'cuentas', 'accesos'], descripcion: 'Por omisión `operaciones`' },
  q: { tipo: 'string', descripcion: 'Texto a buscar', ejemplo: 'PBA1234' },
  desde: { tipo: 'string', formato: 'date-time' },
  hasta: { tipo: 'string', formato: 'date-time' },
  resultado: { tipo: 'string', valores: ['exito', 'fallo'], descripcion: 'Solo para la fuente `accesos`' },
};

/** Las dos listas de control comparten contrato (routes/listas.ts → crearRouter). */
function rutasLista(prefijo: string, etiqueta: string, nombre: string, permiso: 'padron:gestionar' | 'alertas:gestionar',
  cuerpo: Record<string, CampoDoc>): RutaDoc[] {
  return [
    {
      metodo: 'get', ruta: `${prefijo}/`, etiqueta, acceso: 'listas:ver',
      resumen: `Registros activos de la ${nombre}`,
      descripcion: 'Incluye vigentes y vencidos (marcas `vigente`, `por_vencer`, `pendiente_inicio`) y el número de ingresos asociados.',
    },
    {
      metodo: 'get', ruta: `${prefijo}/:id(\\d+)`, etiqueta, acceso: 'listas:ver',
      resumen: `Detalle de un registro de la ${nombre}`,
      respuestas: { 400: 'Identificador inválido', 404: 'Registro no encontrado' },
    },
    {
      metodo: 'post', ruta: `${prefijo}/`, etiqueta, acceso: permiso,
      resumen: `Alta de un registro en la ${nombre}`,
      descripcion: 'Si la placa se había retirado, el registro se reactiva (respuesta 200). Queda en la auditoría.',
      cuerpo,
      respuestas: { 200: 'Registro reactivado', 201: 'Registro creado', 400: 'Datos inválidos', 409: 'La placa ya está en la lista' },
    },
    {
      metodo: 'put', ruta: `${prefijo}/:id(\\d+)`, etiqueta, acceso: permiso,
      resumen: `Edición de un registro de la ${nombre}`,
      cuerpo,
      respuestas: { 400: 'Datos inválidos', 404: 'Registro no encontrado', 409: 'Otro registro tiene la misma placa' },
    },
    {
      metodo: 'delete', ruta: `${prefijo}/:id(\\d+)`, etiqueta, acceso: permiso,
      resumen: `Retiro (baja lógica) de un registro de la ${nombre}`,
      cuerpo: { motivo: { tipo: 'string', descripcion: 'Motivo del retiro (mínimo 5 caracteres)', requerido: true, ejemplo: 'Finalizó el contrato' } },
      respuestas: { 400: 'Falta el motivo', 404: 'Registro no encontrado' },
    },
  ];
}

export const RUTAS: RutaDoc[] = [
  // ─── Autenticación ──────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/auth/estado', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Estado del sistema para la pantalla de inicio de sesión',
    descripcion: 'Indica si falta la configuración inicial, si el registro público está habilitado, si hay SMTP y los dominios permitidos.',
  },
  {
    metodo: 'post', ruta: '/api/auth/configuracion-inicial', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Crea el primer administrador del sistema',
    descripcion: 'Solo funciona mientras no exista ningún administrador; devuelve la sesión iniciada.',
    cuerpo: {
      email: { tipo: 'string', formato: 'email', requerido: true, descripcion: 'Correo institucional (dominios permitidos en la configuración)', ejemplo: 'admin@ecu911.gob.ec' },
      nombre_completo: { tipo: 'string', requerido: true, descripcion: 'Nombres y apellidos: letras, espacios y . \' - & (3 a 150)', ejemplo: 'María Torres' },
      password: { tipo: 'string', formato: 'password', requerido: true, descripcion: '10 a 128 caracteres con mayúscula, minúscula, número y símbolo' },
      cargo: { tipo: 'string', descripcion: 'Letras, números, espacios y . , / # ( ) - (máx. 100)', ejemplo: 'Jefa de sistemas' },
    },
    respuestas: { 201: 'Administrador creado (incluye token)', 400: 'Datos inválidos', 409: 'Ya existe un administrador' },
  },
  {
    metodo: 'post', ruta: '/api/auth/login', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Inicio de sesión con correo y contraseña',
    descripcion: 'Devuelve el JWT y los datos del usuario con sus permisos. Tras varios intentos fallidos la cuenta se bloquea temporalmente.',
    cuerpo: {
      email: { tipo: 'string', formato: 'email', requerido: true, descripcion: 'Correo (también se acepta `username`)', ejemplo: 'guardia@ecu911.gob.ec' },
      password: { tipo: 'string', formato: 'password', requerido: true },
    },
    respuestas: {
      200: 'Sesión iniciada', 400: 'Faltan credenciales', 401: 'Correo o contraseña incorrectos',
      403: 'Cuenta bloqueada, inactiva o sin verificar (codigo EMAIL_NO_VERIFICADO)', 423: 'Cuenta bloqueada temporalmente por intentos',
    },
  },
  {
    metodo: 'post', ruta: '/api/auth/registro', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Registro público de una cuenta (rol Guardia)',
    descripcion: 'Crea la cuenta pendiente y envía el correo de verificación. Requiere que el registro público esté habilitado.',
    cuerpo: {
      email: { tipo: 'string', formato: 'email', requerido: true, descripcion: 'Correo institucional (dominios permitidos en la configuración)', ejemplo: 'guardia@ecu911.gob.ec' },
      nombre_completo: { tipo: 'string', requerido: true, descripcion: 'Nombres y apellidos: letras, espacios y . \' - & (3 a 150)', ejemplo: 'Carlos Andrade' },
      password: { tipo: 'string', formato: 'password', requerido: true, descripcion: '10 a 128 caracteres con mayúscula, minúscula, número y símbolo' },
      cargo: { tipo: 'string', descripcion: 'Letras, números, espacios y . , / # ( ) - (máx. 100)', ejemplo: 'Guardia de garita' },
    },
    respuestas: { 201: 'Cuenta creada', 400: 'Datos inválidos', 403: 'Registro público deshabilitado', 409: 'Ya existe una cuenta con ese correo' },
  },
  {
    metodo: 'get', ruta: '/api/auth/verificar-email', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Activa la cuenta con el token del correo de verificación',
    consulta: { token: { tipo: 'string', requerido: true, descripcion: 'Token de 64 caracteres hexadecimales' } },
    respuestas: { 400: 'Enlace inválido', 410: 'Enlace expirado (codigo TOKEN_EXPIRADO)' },
  },
  {
    metodo: 'post', ruta: '/api/auth/reenviar-verificacion', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Envía un nuevo enlace de verificación',
    descripcion: 'La respuesta es siempre genérica; máximo un reenvío por minuto.',
    cuerpo: { email: { tipo: 'string', formato: 'email', ejemplo: 'guardia@ecu911.gob.ec' } },
  },
  {
    metodo: 'post', ruta: '/api/auth/olvide-password', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Solicita el enlace para restablecer la contraseña',
    descripcion: 'La respuesta es idéntica exista o no la cuenta (no revela correos registrados); máximo un enlace por minuto.',
    cuerpo: { email: { tipo: 'string', formato: 'email', ejemplo: 'guardia@ecu911.gob.ec' } },
  },
  {
    metodo: 'post', ruta: '/api/auth/restablecer-password', etiqueta: 'Autenticación', acceso: 'publica',
    resumen: 'Define una nueva contraseña con el token del correo',
    descripcion: 'También activa la cuenta creada por un administrador (enlace del correo de bienvenida).',
    cuerpo: {
      token: { tipo: 'string', requerido: true, descripcion: 'Token de 64 caracteres hexadecimales' },
      password: { tipo: 'string', formato: 'password', requerido: true, descripcion: '10 a 128 caracteres con mayúscula, minúscula, número y símbolo' },
    },
    respuestas: { 400: 'Enlace inválido, usado o contraseña débil', 410: 'Enlace expirado' },
  },
  {
    metodo: 'get', ruta: '/api/auth/me', etiqueta: 'Autenticación', acceso: 'sesion',
    resumen: 'Datos de la sesión actual con los permisos del rol',
    respuestas: { 401: 'Sin sesión, sesión vencida o cuenta que ya no está activa' },
  },
  {
    metodo: 'put', ruta: '/api/auth/perfil', etiqueta: 'Autenticación', acceso: 'sesion',
    resumen: 'Actualiza el nombre y cargo propios',
    descripcion: 'El correo y el rol los gestiona el administrador.',
    cuerpo: {
      nombre_completo: { tipo: 'string', requerido: true, descripcion: 'Nombres y apellidos: letras, espacios y . \' - & (3 a 150)', ejemplo: 'María Torres' },
      cargo: { tipo: 'string', descripcion: 'Letras, números, espacios y . , / # ( ) - (máx. 100)', ejemplo: 'Supervisora de turno' },
    },
    respuestas: { 400: 'Datos inválidos' },
  },
  {
    metodo: 'post', ruta: '/api/auth/cambiar-password', etiqueta: 'Autenticación', acceso: 'sesion',
    resumen: 'Cambia la contraseña propia con la contraseña actual',
    cuerpo: {
      actual: { tipo: 'string', formato: 'password', requerido: true, descripcion: 'Contraseña actual' },
      nueva: {
        tipo: 'string', formato: 'password', requerido: true,
        descripcion: 'Nueva contraseña: 10 a 128 caracteres con mayúscula, minúscula, número y símbolo (distinta de la actual)',
      },
    },
    respuestas: { 400: 'Contraseña actual incorrecta o nueva inválida' },
  },

  // ─── Usuarios ───────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/usuarios/', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Listado de cuentas del personal',
  },
  {
    metodo: 'get', ruta: '/api/usuarios/roles', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Catálogo de roles con sus permisos',
  },
  {
    metodo: 'get', ruta: '/api/usuarios/:id', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Detalle de una cuenta (mismo formato que un elemento del listado)',
    respuestas: { 400: 'Identificador inválido', 404: 'Usuario no encontrado' },
  },
  {
    metodo: 'post', ruta: '/api/usuarios/', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Crea una cuenta y envía el enlace para definir la contraseña',
    descripcion: 'El administrador nunca conoce la contraseña: el usuario la define con el enlace recibido por correo.',
    cuerpo: {
      email: { tipo: 'string', formato: 'email', requerido: true, descripcion: 'Correo institucional (dominios permitidos en la configuración)', ejemplo: 'guardia@ecu911.gob.ec' },
      nombre_completo: { tipo: 'string', requerido: true, descripcion: 'Nombres y apellidos: letras, espacios y . \' - & (3 a 150)', ejemplo: 'Luis Mendoza' },
      rol: { tipo: 'string', requerido: true, valores: ['Admin', 'Guardia', 'GestorPermisos'], ejemplo: 'Guardia' },
      cargo: { tipo: 'string', descripcion: 'Letras, números, espacios y . , / # ( ) - (máx. 100)', ejemplo: 'Guardia de garita' },
    },
    respuestas: { 201: 'Usuario creado', 400: 'Datos inválidos', 409: 'Ya existe una cuenta con ese correo' },
  },
  {
    metodo: 'put', ruta: '/api/usuarios/:id', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Edita nombre, cargo, rol y estado de una cuenta',
    descripcion: 'Solo se valida y guarda lo que llega; el resto conserva su valor. Debe quedar al menos un administrador activo; '
      + 'nadie puede quitarse a sí mismo el rol de administrador. Un cambio de rol o de estado surte efecto en sus sesiones abiertas en segundos.',
    cuerpo: {
      nombre_completo: { tipo: 'string', descripcion: 'Nombres y apellidos: letras, espacios y . \' - & (3 a 150)', ejemplo: 'Luis Mendoza' },
      cargo: { tipo: 'string', descripcion: 'Letras, números, espacios y . , / # ( ) - (máx. 100)', ejemplo: 'Supervisor' },
      rol: { tipo: 'string', valores: ['Admin', 'Guardia', 'GestorPermisos'], ejemplo: 'GestorPermisos' },
      estado: { tipo: 'string', valores: ['activo', 'inactivo', 'pendiente'] },
    },
    respuestas: { 400: 'Identificador o datos inválidos, o dejaría el sistema sin administrador', 404: 'Usuario no encontrado' },
  },
  {
    metodo: 'post', ruta: '/api/usuarios/:id/bloquear', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Bloqueo administrativo de una cuenta',
    cuerpo: { motivo: { tipo: 'string', descripcion: 'Opcional; texto libre sin < > (máx. 300). Queda en la auditoría', ejemplo: 'Fin de la relación laboral' } },
    respuestas: { 400: 'Identificador o motivo inválido; no puede bloquearse a sí mismo ni al último administrador', 404: 'Usuario no encontrado' },
  },
  {
    metodo: 'post', ruta: '/api/usuarios/:id/desbloquear', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Quita los bloqueos administrativo y por intentos fallidos',
    respuestas: { 400: 'Identificador inválido', 404: 'Usuario no encontrado' },
  },
  {
    metodo: 'post', ruta: '/api/usuarios/:id/restablecer-password', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Envía al usuario un enlace de restablecimiento de contraseña',
    respuestas: { 400: 'Identificador inválido', 404: 'Usuario no encontrado' },
  },
  {
    metodo: 'delete', ruta: '/api/usuarios/:id', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Baja lógica de una cuenta (estado inactivo)',
    descripcion: 'La cuenta ya no puede iniciar sesión y sus sesiones abiertas se cierran en segundos; se conservan su historial y su '
      + 'auditoría (acción USUARIO_DADO_DE_BAJA en la auditoría de cuentas). Se revierte editando el estado a activo.',
    cuerpo: {
      motivo: { tipo: 'string', requerido: true, descripcion: 'Motivo de la baja: texto libre sin < > (5 a 300 caracteres)', ejemplo: 'Fin de la relación laboral' },
    },
    respuestas: {
      200: 'Cuenta dada de baja (incluye la cuenta actualizada)', 400: 'Identificador o motivo inválido',
      403: 'No puede dar de baja su propia cuenta (o el rol no tiene el permiso requerido)', 404: 'Usuario no encontrado',
      409: 'La cuenta ya estaba dada de baja o es el único administrador activo',
    },
  },
  {
    metodo: 'get', ruta: '/api/usuarios/auditoria', etiqueta: 'Usuarios', acceso: 'usuarios:gestionar',
    resumen: 'Acciones administrativas y accesos recientes',
    consulta: { limite: { tipo: 'integer', descripcion: 'Registros por tabla (10 a 500)', ejemplo: 200 } },
  },

  // ─── Cámaras ────────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/camaras/', etiqueta: 'Cámaras', acceso: 'operacion:monitorear',
    resumen: 'Listado de cámaras (credenciales RTSP enmascaradas)',
  },
  {
    metodo: 'get', ruta: '/api/camaras/:id(\\d+)', etiqueta: 'Cámaras', acceso: 'operacion:monitorear',
    resumen: 'Detalle de una cámara (credenciales RTSP enmascaradas)',
    descripcion: 'Mismo formato que cada elemento del listado.',
    respuestas: { 400: 'Identificador inválido', 404: 'Cámara no encontrada' },
  },
  {
    metodo: 'post', ruta: '/api/camaras/', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Registra una cámara',
    descripcion: 'La primera verificación de conectividad se ejecuta en segundo plano.',
    cuerpo: CAMARA,
    respuestas: { 201: 'Cámara registrada', 400: 'Datos inválidos' },
  },
  {
    metodo: 'put', ruta: '/api/camaras/:id(\\d+)', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Edita una cámara',
    descripcion: 'Si cambia la URL, la conectividad vuelve a verificarse en segundo plano.',
    cuerpo: CAMARA,
    respuestas: { 400: 'Datos o identificador inválidos', 404: 'Cámara no encontrada' },
  },
  {
    metodo: 'patch', ruta: '/api/camaras/:id(\\d+)/toggle', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Habilita o deshabilita una cámara',
    respuestas: { 400: 'Identificador inválido', 404: 'Cámara no encontrada' },
  },
  {
    metodo: 'put', ruta: '/api/camaras/:id(\\d+)/roi', etiqueta: 'Cámaras', acceso: 'camaras:operar',
    resumen: 'Define la región de interés de la cámara',
    descripcion: 'Polígono de 3 a 12 vértices con coordenadas numéricas normalizadas (0–1); el motor solo busca placas cuyo centro cae dentro. `null` o `[]` usa el cuadro completo.',
    cuerpo: { roi: { tipo: 'array', descripcion: 'Vértices [[x, y], …] normalizados, o null', ejemplo: [[0.1, 0.3], [0.9, 0.3], [0.9, 0.95], [0.1, 0.95]] } },
    respuestas: { 400: 'Región o identificador inválidos', 404: 'Cámara no encontrada' },
  },
  {
    metodo: 'delete', ruta: '/api/camaras/:id(\\d+)', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Elimina una cámara sin historial',
    respuestas: { 400: 'Identificador inválido', 404: 'Cámara no encontrada', 409: 'La cámara tiene detecciones: debe deshabilitarse' },
  },
  {
    metodo: 'post', ruta: '/api/camaras/probar', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Ping y diagnóstico RTSP de una URL antes de guardarla',
    descripcion: 'Una URL que no se puede interpretar se informa en el diagnóstico (`url_invalida`).',
    cuerpo: {
      rtsp_url: { tipo: 'string', requerido: true, descripcion: CAMARA.rtsp_url.descripcion, ejemplo: 'rtsp://admin:clave@192.168.1.64:554/Streaming/Channels/101' },
      ip: CAMARA.ip,
      camara_id: CAMARA_PRUEBA,
    },
    respuestas: { 400: 'URL, IP o cámara inválidas' },
  },
  {
    metodo: 'post', ruta: '/api/camaras/:id(\\d+)/ping', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Ping ICMP y diagnóstico RTSP de una cámara registrada',
    respuestas: { 400: 'Identificador inválido', 404: 'Cámara no encontrada' },
  },
  {
    metodo: 'post', ruta: '/api/camaras/ping-all', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Diagnóstico de todas las cámaras habilitadas',
  },
  {
    metodo: 'post', ruta: '/api/camaras/:id(\\d+)/video', etiqueta: 'Cámaras', acceso: 'operacion:monitorear',
    resumen: 'Ruta y ticket para reproducir la cámara por WebRTC',
    respuestas: { 400: 'Identificador inválido', 404: 'Cámara no encontrada', 409: 'Cámara deshabilitada', 502: 'El servidor de video no respondió' },
  },
  {
    metodo: 'post', ruta: '/api/camaras/prueba-video', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Ruta temporal para reproducir una URL sin guardarla',
    descripcion: 'La ruta temporal se elimina al cerrar la vista previa o a los 3 minutos.',
    cuerpo: {
      rtsp_url: { tipo: 'string', requerido: true, descripcion: CAMARA.rtsp_url.descripcion, ejemplo: 'rtsp://admin:clave@192.168.1.64:554/Streaming/Channels/101' },
      camara_id: CAMARA_PRUEBA,
    },
    respuestas: { 400: 'URL RTSP o cámara inválidas', 502: 'El servidor de video no respondió' },
  },
  {
    metodo: 'delete', ruta: '/api/camaras/prueba-video/:ruta', etiqueta: 'Cámaras', acceso: 'camaras:gestionar',
    resumen: 'Elimina la ruta temporal de reproducción',
    descripcion: 'Solo se eliminan rutas `prueba_<hex>`; cualquier otro nombre (p. ej. `cam_<id>`) se ignora. Responde `{ ok: true }`.',
  },
  {
    metodo: 'get', ruta: '/api/camaras/video/:ruta/estado', etiqueta: 'Cámaras', acceso: 'operacion:monitorear',
    resumen: 'Estado del flujo de video en MediaMTX',
    respuestas: { 400: 'Ruta inválida' },
  },

  // ─── Detecciones ────────────────────────────────────────────────────────────
  {
    metodo: 'post', ruta: '/api/detecciones/ingreso', etiqueta: 'Detecciones', acceso: 'servicio',
    resumen: 'Fase 1: registra la captura de un vehículo (pendiente de OCR)',
    descripcion: 'Un paso físico es un registro: se reutiliza el ingreso con el mismo tracking_id o placa en los últimos 35 s.',
    cuerpo: {
      ruta_imagen_ingreso: { tipo: 'string', requerido: true, ejemplo: 'ingreso_20261001_083015_42.jpg' },
      tracking_id: { tipo: 'integer', ejemplo: 42 },
      confianza_deteccion: { tipo: 'number', ejemplo: 0.91 },
      fuente: { tipo: 'string', ejemplo: 'webcam' },
      camara_id: { tipo: 'integer', ejemplo: 1 },
      placa: { tipo: 'string', descripcion: 'Pista de la placa para deduplicar', ejemplo: 'PBA1234' },
      metadatos: { tipo: 'object', descripcion: 'Condiciones de captura (luminancia, distancia, nitidez…)' },
    },
    respuestas: { 200: 'Registro existente reutilizado', 201: 'Ingreso registrado', 400: 'Falta la imagen de ingreso' },
  },
  {
    metodo: 'post', ruta: '/api/detecciones/completar-ocr', etiqueta: 'Detecciones', acceso: 'servicio',
    resumen: 'Fase 2: resultado OCR, cruce con las listas y decisión de acceso',
    cuerpo: {
      ingreso_id: { tipo: 'integer', requerido: true, ejemplo: 1532 },
      placa_reconocida: { tipo: 'string', ejemplo: 'PBA1234' },
      confianza_ocr: { tipo: 'number', ejemplo: 0.97 },
      ruta_imagen_placa: { tipo: 'string', ejemplo: 'placa_20261001_083015_42.jpg' },
      estado_procesamiento: { tipo: 'string', descripcion: 'Por omisión `procesado`', ejemplo: 'procesado' },
      lectura_verificador: { tipo: 'string', descripcion: 'Lectura del segundo OCR', ejemplo: 'PBA1234' },
      latencia_ms: { tipo: 'integer', ejemplo: 420 },
      lectura_valida: { tipo: 'boolean', descripcion: 'Veredicto del motor sobre la lectura' },
      evidencia_lectura: { tipo: 'object', descripcion: 'Evidencias que respaldan el veredicto' },
    },
    respuestas: { 400: 'Falta el ID de ingreso', 404: 'Ingreso no encontrado' },
  },
  {
    metodo: 'post', ruta: '/api/detecciones/descarte', etiqueta: 'Detecciones', acceso: 'servicio',
    resumen: 'Audita un falso positivo descartado por el motor',
    cuerpo: {
      tracking_id: { tipo: 'integer', ejemplo: 42 },
      motivo: { tipo: 'string', ejemplo: 'falso_positivo_ocr' },
      texto_candidato: { tipo: 'string', ejemplo: 'P8A12' },
      confianza: { tipo: 'number', ejemplo: 0.41 },
      fuente: { tipo: 'string', ejemplo: 'webcam' },
      camara_id: { tipo: 'integer', ejemplo: 1 },
    },
    respuestas: { 201: 'Descarte registrado' },
  },
  {
    metodo: 'get', ruta: '/api/detecciones/', etiqueta: 'Detecciones', acceso: 'operacion:monitorear',
    resumen: 'Historial de ingresos paginado y con filtros',
    consulta: { ...FILTROS_DETECCIONES, ...PAGINACION },
  },
  {
    metodo: 'get', ruta: '/api/detecciones/recientes', etiqueta: 'Detecciones', acceso: 'operacion:monitorear',
    resumen: 'Últimos pasos vehiculares (monitoreo)',
    consulta: { limite: { tipo: 'integer', descripcion: 'Cantidad (1 a 50)', ejemplo: 20 } },
  },
  {
    metodo: 'get', ruta: '/api/detecciones/exportar', etiqueta: 'Detecciones', acceso: 'operacion:monitorear',
    resumen: 'Exporta el historial a CSV con los mismos filtros',
    descripcion: 'La exportación queda registrada en la auditoría.',
    consulta: FILTROS_DETECCIONES,
    archivo: 'text/csv',
  },
  {
    metodo: 'get', ruta: '/api/detecciones/buscar-placa/:placa', etiqueta: 'Detecciones', acceso: 'operacion:monitorear',
    resumen: 'Situación de una placa en las listas e historial reciente',
    respuestas: { 400: 'Placa demasiado corta' },
  },
  {
    metodo: 'get', ruta: '/api/detecciones/:id(\\d+)', etiqueta: 'Detecciones', acceso: 'operacion:monitorear',
    resumen: 'Detalle de un ingreso con lectura automática y auditoría',
    respuestas: { 404: 'Detección no encontrada' },
  },
  {
    metodo: 'post', ruta: '/api/detecciones/validar/:id(\\d+)', etiqueta: 'Detecciones', acceso: 'detecciones:validar',
    resumen: 'Confirma o corrige la lectura de un ingreso',
    descripcion: 'Con `excepcion: true` concede el paso pese a la restricción temporal del permiso: exige además el permiso `accesos:excepcion` y un motivo.',
    cuerpo: {
      placa_validada: { tipo: 'string', requerido: true, descripcion: 'Formato ANT: ABC-1234 (automóvil) o AB-123C (motocicleta)', ejemplo: 'PBA1234' },
      tipo_vehiculo: { tipo: 'string', ejemplo: 'Automóvil' },
      observacion: { tipo: 'string', descripcion: 'Texto libre sin < >, hasta 300 caracteres (obligatoria con excepción, mínimo 5)' },
      excepcion: { tipo: 'boolean', descripcion: 'Autorizar por excepción' },
    },
    respuestas: { 400: 'Placa fuera del formato ANT, tipo u observación inválidos o falta el motivo de la excepción', 403: 'Sin permiso para excepciones', 404: 'Detección no encontrada' },
  },
  {
    metodo: 'post', ruta: '/api/detecciones/registro-manual', etiqueta: 'Detecciones', acceso: 'detecciones:validar',
    resumen: 'Registra a mano un paso vehicular',
    descripcion: 'Se cruza con las listas como una lectura automática; no modifica el padrón de autorizados.',
    cuerpo: {
      placa: { tipo: 'string', requerido: true, descripcion: 'Formato ANT: ABC-1234 (automóvil) o AB-123C (motocicleta)', ejemplo: 'PBA1234' },
      motivo: { tipo: 'string', requerido: true, descripcion: 'Texto libre sin < >, 5 a 300 caracteres', ejemplo: 'Cámara fuera de servicio' },
      camara_id: { tipo: 'integer', ejemplo: 1 },
      tipo_vehiculo: { tipo: 'string', ejemplo: 'Camioneta' },
    },
    respuestas: { 201: 'Ingreso registrado', 400: 'Placa fuera del formato ANT, motivo, tipo o cámara inválidos' },
  },
  {
    metodo: 'delete', ruta: '/api/detecciones/:id(\\d+)', etiqueta: 'Detecciones', acceso: 'detecciones:eliminar',
    resumen: 'Elimina un ingreso y su evidencia fotográfica',
    cuerpo: { motivo: { tipo: 'string', requerido: true, descripcion: 'Texto libre sin < >, 3 a 300 caracteres', ejemplo: 'Registro de prueba' } },
    respuestas: { 400: 'Motivo o identificador inválido', 404: 'Detección no encontrada' },
  },
  {
    metodo: 'delete', ruta: '/api/detecciones/', etiqueta: 'Detecciones', acceso: 'detecciones:eliminar',
    resumen: 'Eliminación masiva de ingresos (todos o los filtrados)',
    descripcion: 'Sin filtros elimina todas las detecciones. Exige escribir ELIMINAR y un motivo; borra también la evidencia.',
    consulta: FILTROS_DETECCIONES,
    cuerpo: {
      confirmacion: { tipo: 'string', requerido: true, valores: ['ELIMINAR'] },
      motivo: { tipo: 'string', requerido: true, descripcion: 'Texto libre sin < >, 5 a 300 caracteres', ejemplo: 'Depuración de pruebas piloto' },
    },
    respuestas: { 400: 'Falta la confirmación, motivo inválido o filtros inválidos' },
  },

  // ─── Listas de control ──────────────────────────────────────────────────────
  ...rutasLista('/api/vehiculos-autorizados', 'Lista blanca', 'lista blanca',
    'padron:gestionar', CUERPO_AUTORIZADO),
  ...rutasLista('/api/blacklist', 'Lista negra', 'lista negra', 'alertas:gestionar', CUERPO_ALERTA),

  // ─── Panel ──────────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/panel/resumen', etiqueta: 'Panel', acceso: 'operacion:monitorear',
    resumen: 'Indicadores de operación del día y de los últimos 7 días',
  },
  {
    metodo: 'get', ruta: '/api/panel/accesos', etiqueta: 'Panel', acceso: 'padron:gestionar',
    resumen: 'Panel del gestor: solicitudes, padrón, denegados y reincidentes',
  },
  {
    metodo: 'get', ruta: '/api/panel/administracion', etiqueta: 'Panel', acceso: 'usuarios:gestionar',
    resumen: 'Panel de administración: cuentas, accesos, actividad y servicios',
  },

  // ─── Monitoreo ──────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/monitoreo/estado', etiqueta: 'Monitoreo', acceso: 'operacion:monitorear',
    resumen: 'Estado del motor ANPR y cámara que procesa',
    descripcion: 'La cámara activa se informa solo si el motor procesa la ruta de una cámara registrada; si procesa otra fuente, `fuente_externa` es true.',
  },
  {
    metodo: 'post', ruta: '/api/monitoreo/camara-activa', etiqueta: 'Monitoreo', acceso: 'camaras:operar',
    resumen: 'Cambia la cámara que procesa el motor ANPR',
    descripcion: 'El cambio queda en la auditoría y se difunde en tiempo real (`monitoreo:camara`).',
    cuerpo: { camara_id: { tipo: 'integer', requerido: true, descripcion: 'Cámara habilitada (entero positivo)', ejemplo: 1 } },
    respuestas: { 400: 'Cámara no seleccionada o inválida', 404: 'Cámara no encontrada', 409: 'Cámara deshabilitada', 502: 'El servicio ANPR no respondió' },
  },
  {
    metodo: 'post', ruta: '/api/monitoreo/ticket', etiqueta: 'Monitoreo', acceso: 'operacion:monitorear',
    resumen: 'Credencial de 60 s para el video en vivo',
    descripcion: 'El alcance `webcam` (enviar la webcam del navegador al motor) exige además el permiso `camaras:gestionar`.',
    cuerpo: { alcance: { tipo: 'string', valores: ['stream', 'webcam'], descripcion: 'Por omisión `stream`' } },
    respuestas: { 400: 'Alcance inválido', 403: 'Sin permiso para usar la webcam como fuente' },
  },

  // ─── Reportes ───────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/reportes/', etiqueta: 'Reportes', acceso: 'reportes:ver',
    resumen: 'Reporte consolidado de un período',
    descripcion: 'Por omisión, los últimos 7 días locales; máximo un año por consulta. Fechas AAAA-MM-DD o ISO 8601 y cámara '
      + 'entera positiva; un valor inválido responde 400 (antes se ignoraba).',
    consulta: {
      desde: { tipo: 'string', formato: 'date-time', ejemplo: '2026-09-01T00:00:00' },
      hasta: { tipo: 'string', formato: 'date-time', ejemplo: '2026-09-30T23:59:59' },
      camara: { tipo: 'integer', descripcion: 'ID de la cámara', ejemplo: 1 },
    },
    respuestas: { 400: 'Fecha o cámara inválida, período invertido o mayor a un año' },
  },

  // ─── Configuración ──────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/configuracion/', etiqueta: 'Configuración', acceso: 'configuracion:gestionar',
    resumen: 'Parámetros editables y datos del entorno',
    descripcion: 'Cada parámetro trae su tipo (booleano, entero con min/max, lista, opción o texto), el valor vigente y su origen (sistema, entorno u omisión).',
  },
  {
    metodo: 'put', ruta: '/api/configuracion/', etiqueta: 'Configuración', acceso: 'configuracion:gestionar',
    resumen: 'Guarda parámetros del sistema',
    descripcion: 'Todos los valores se validan antes de guardar según el tipo declarado del parámetro: enteros dentro de su rango, '
      + 'booleanos true/false, dominios de correo como nombres de host, una de las opciones o texto libre (1 a 150, sin < >). '
      + 'Una clave desconocida o un valor inválido responden 400 sin guardar nada; cada cambio queda en la auditoría.',
    cuerpo: {
      valores: { tipo: 'object', requerido: true, descripcion: 'Mapa clave → valor', ejemplo: { aviso_vencimiento_dias: '15' } },
    },
    respuestas: { 400: 'Sin cambios, parámetro desconocido o valor inválido' },
  },

  // ─── Auditoría ──────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/auditoria/', etiqueta: 'Auditoría', acceso: 'auditoria:ver',
    resumen: 'Consulta paginada de la auditoría',
    descripcion: 'La auditoría es inmutable (ISO/IEC 27001 A.8.15, OWASP ASVS V7): ninguna ruta edita ni borra registros.',
    consulta: { ...FILTROS_AUDITORIA, ...PAGINACION },
  },
  {
    metodo: 'get', ruta: '/api/auditoria/exportar', etiqueta: 'Auditoría', acceso: 'auditoria:ver',
    resumen: 'Exporta la auditoría a CSV',
    descripcion: 'Mismos filtros que la consulta; todas las columnas de la fuente, hasta 50 000 registros (los más recientes). '
      + 'CSV RFC 4180 en UTF-8 con BOM; las celdas que empiezan con = + - @ llevan un apóstrofo delante (inyección de fórmulas). '
      + 'Archivo `auditoria_<fuente>_<AAAA-MM-DD>.csv`; la exportación queda en la auditoría (AUDITORIA_EXPORTADA).',
    consulta: FILTROS_AUDITORIA,
    archivo: 'text/csv',
  },
  {
    metodo: 'get', ruta: '/api/auditoria/:fuente(operaciones|cuentas|accesos)/:id(\\d+)', etiqueta: 'Auditoría', acceso: 'auditoria:ver',
    resumen: 'Detalle de un registro de auditoría (todas sus columnas)',
    respuestas: { 400: 'Identificador inválido', 404: 'Registro de auditoría no encontrado' },
  },
  {
    metodo: 'post', ruta: '/api/auditoria/retencion', etiqueta: 'Auditoría', acceso: 'auditoria:ver',
    resumen: 'Retención: traslada al archivo los registros antiguos',
    descripcion: 'Mueve los registros con más de `dias` días a AuditoriaOperacionesArchivo, AuditoriaUsuariosArchivo y '
      + 'AuditoriaAccesosArchivo en una sola transacción (copia y después elimina solo lo copiado): no se pierde evidencia. '
      + 'Responde { archivados: { operaciones, cuentas, accesos } } y queda en la auditoría (AUDITORIA_RETENCION).',
    cuerpo: { dias: { tipo: 'integer', requerido: true, descripcion: 'Antigüedad mínima, en días, de lo que se archiva (365 a 3650)', ejemplo: 730 } },
    respuestas: { 400: 'Plazo fuera de 365 a 3650 días' },
  },

  // ─── Medios ─────────────────────────────────────────────────────────────────
  {
    metodo: 'post', ruta: '/api/medios/autorizar', etiqueta: 'Medios', acceso: 'publica',
    resumen: 'Autorización de lecturas de MediaMTX (authMethod http)',
    descripcion: 'Lo consulta MediaMTX antes de cada lectura: navegador con ticket WebRTC o motor ANPR por RTSP. Responde sin cuerpo.',
    cuerpo: {
      user: { tipo: 'string' },
      password: { tipo: 'string', formato: 'password' },
      action: { tipo: 'string', ejemplo: 'read' },
      path: { tipo: 'string', ejemplo: 'cam_1' },
      protocol: { tipo: 'string', ejemplo: 'webrtc' },
      query: { tipo: 'string', ejemplo: 'ticket=…' },
    },
    respuestas: { 200: 'Autorizado', 401: 'Denegado' },
  },

  // ─── Evaluación ─────────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/evaluacion/resumen', etiqueta: 'Evaluación', acceso: 'evaluacion:ver',
    resumen: 'Métricas de evaluación del reconocimiento en un período',
    descripcion: 'Exactitud de placa, CER, tasas de falsa aceptación y falso rechazo y latencia, con intervalos de confianza de '
      + 'Wilson al 95 %, sobre los pasos validados por el personal. Días inclusivos (el final hasta las 23:59:59).',
    consulta: {
      desde: { tipo: 'string', formato: 'date', ejemplo: '2026-09-01' },
      hasta: { tipo: 'string', formato: 'date', ejemplo: '2026-09-30' },
      camara_id: { tipo: 'integer', ejemplo: 1 },
    },
    respuestas: { 400: 'Fecha inválida, período invertido o cámara inválida' },
  },
  {
    metodo: 'get', ruta: '/api/evaluacion/export.csv', etiqueta: 'Evaluación', acceso: 'evaluacion:ver',
    resumen: 'CSV de evaluación (una fila por paso vehicular)',
    descripcion: 'Alimenta services/anpr/scripts/estadistica.py (bootstrap, McNemar). Los textos que empiezan como fórmula '
      + '(= + - @) llevan un apóstrofo delante (inyección CSV); los números se exportan sin cambios.',
    consulta: {
      desde: { tipo: 'string', formato: 'date', ejemplo: '2026-09-01' },
      hasta: { tipo: 'string', formato: 'date', ejemplo: '2026-09-30' },
      camara_id: { tipo: 'integer', ejemplo: 1 },
    },
    archivo: 'text/csv',
    respuestas: { 400: 'Fecha inválida, período invertido o cámara inválida' },
  },

  // ─── Propietario ────────────────────────────────────────────────────────────
  {
    metodo: 'post', ruta: '/api/propietario/consulta', etiqueta: 'Propietario', acceso: 'propietario:consultar',
    resumen: 'Consulta los datos del propietario de una placa',
    descripcion: 'Requiere convenio con DINARDAP / ANT. Motivo obligatorio, límite por hora y registro de toda consulta en la auditoría.',
    cuerpo: {
      placa: { tipo: 'string', requerido: true, descripcion: 'Formato ANT: ABC-1234 (automóvil) o AB-123C (motocicleta)', ejemplo: 'PBA1234' },
      motivo: { tipo: 'string', requerido: true, descripcion: 'Base legal de la consulta: texto libre sin < >, 10 a 255 caracteres', ejemplo: 'Investigación de alerta #1532' },
      deteccion_id: { tipo: 'integer', ejemplo: 1532 },
    },
    respuestas: {
      400: 'Placa, motivo o paso vehicular inválidos', 404: 'Sin datos para la placa', 429: 'Límite de consultas por hora',
      502: 'Error del servicio oficial', 503: 'Consulta no habilitada',
    },
  },
  {
    metodo: 'get', ruta: '/api/propietario/auditoria', etiqueta: 'Propietario', acceso: 'propietario:consultar',
    resumen: 'Últimas consultas de propietario registradas',
  },

  // ─── Notificaciones ─────────────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/notificaciones/', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Bandeja de notificaciones del usuario',
    consulta: {
      limite: { tipo: 'integer', descripcion: '1 a 100', ejemplo: 30 },
      antes_de: { tipo: 'integer', descripcion: 'Paginación: notificaciones con id menor' },
      desde: { tipo: 'integer', descripcion: 'Recuperación tras reconectar: nuevas o modificadas después de este id' },
      filtro: { tipo: 'string', valores: ['no_leidas', 'pendientes'] },
    },
    respuestas: { 400: 'Límite, identificador o filtro inválido' },
  },
  {
    metodo: 'get', ruta: '/api/notificaciones/resumen', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Contadores de no leídas y pendientes (campana)',
  },
  {
    metodo: 'get', ruta: '/api/notificaciones/catalogo', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Catálogo de tipos de notificación',
  },
  {
    metodo: 'post', ruta: '/api/notificaciones/leer-todas', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Marca todas las notificaciones como leídas',
  },
  {
    metodo: 'post', ruta: '/api/notificaciones/:id(\\d+)/leer', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Marca una notificación como leída',
  },
  {
    metodo: 'post', ruta: '/api/notificaciones/:id(\\d+)/reconocer', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Reconocimiento (ACK) de una alarma',
  },
  {
    metodo: 'post', ruta: '/api/notificaciones/reconocer-deteccion/:id(\\d+)', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Reconoce las alarmas de un paso vehicular',
    descripcion: 'Botón "Enterado" del aviso de garita; el id es el de la detección.',
  },
  {
    metodo: 'get', ruta: '/api/notificaciones/push/clave', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Clave pública VAPID y estado del canal push',
  },
  {
    metodo: 'post', ruta: '/api/notificaciones/push/suscripcion', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Registra la suscripción push del navegador',
    cuerpo: {
      endpoint: { tipo: 'string', requerido: true, descripcion: 'URL https del servicio push', ejemplo: 'https://fcm.googleapis.com/fcm/send/…' },
      keys: { tipo: 'object', requerido: true, descripcion: 'Claves `p256dh` y `auth` de la suscripción' },
    },
    respuestas: { 201: 'Suscripción registrada', 400: 'Suscripción inválida' },
  },
  {
    metodo: 'delete', ruta: '/api/notificaciones/push/suscripcion', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Elimina la suscripción push del navegador',
    cuerpo: { endpoint: { tipo: 'string', requerido: true, ejemplo: 'https://fcm.googleapis.com/fcm/send/…' } },
    respuestas: { 400: 'Falta la suscripción' },
  },
  {
    metodo: 'post', ruta: '/api/notificaciones/push/prueba', etiqueta: 'Notificaciones', acceso: 'sesion',
    resumen: 'Envía un push de prueba a los equipos del usuario',
    respuestas: { 404: 'Sin equipos suscritos', 503: 'Canal push no disponible' },
  },
  {
    metodo: 'get', ruta: '/api/notificaciones/metricas', etiqueta: 'Notificaciones', acceso: 'evaluacion:ver',
    resumen: 'Indicadores del canal de notificación (TTA, escalamiento)',
    descripcion: 'Tiempo de reconocimiento por prioridad (mediana y p95), tasa de alarmas por hora y ventanas de avalancha (ISA-18.2).',
    consulta: { dias: { tipo: 'integer', descripcion: 'Período en días (1 a 90)', ejemplo: 7 } },
    respuestas: { 400: 'Días fuera de 1 a 90' },
  },

  // ─── Solicitudes de acceso ──────────────────────────────────────────────────
  {
    metodo: 'get', ruta: '/api/solicitudes-acceso/', etiqueta: 'Solicitudes de acceso', acceso: 'sesion',
    resumen: 'Listado de solicitudes de acceso',
    descripcion: 'Quien tiene `solicitudes:resolver` ve todas; el resto, solo las propias.',
    consulta: {
      estado: { tipo: 'string', valores: ['pendiente', 'resueltas', 'todas'], descripcion: 'Por omisión `pendiente`' },
      mias: { tipo: 'string', valores: ['1'], descripcion: 'Solo las solicitudes propias' },
    },
  },
  {
    metodo: 'get', ruta: '/api/solicitudes-acceso/resumen', etiqueta: 'Solicitudes de acceso', acceso: 'sesion',
    resumen: 'Número de solicitudes pendientes (contador del menú)',
  },
  {
    metodo: 'post', ruta: '/api/solicitudes-acceso/', etiqueta: 'Solicitudes de acceso', acceso: 'solicitudes:crear',
    resumen: 'Crea una solicitud de autorización de placa',
    descripcion: 'Avisa al gestor de permisos y queda en la auditoría (SOLICITUD_CREADA).',
    cuerpo: CUERPO_SOLICITUD,
    respuestas: { 201: 'Solicitud creada', 400: 'Datos inválidos', 409: 'Ya hay una solicitud pendiente para la placa' },
  },
  {
    metodo: 'put', ruta: '/api/solicitudes-acceso/:id(\\d+)', etiqueta: 'Solicitudes de acceso', acceso: 'solicitudes:crear',
    resumen: 'Edita una solicitud propia pendiente',
    descripcion: 'Mismo cuerpo y validaciones que el alta. Solo quien la registró y solo mientras está pendiente; si no se '
      + 'envía `deteccion_id` se conserva el paso de origen. Responde { message, solicitud } y queda en la auditoría (SOLICITUD_EDITADA).',
    cuerpo: CUERPO_SOLICITUD,
    respuestas: {
      400: 'Datos o identificador inválidos', 403: 'Solo quien registró la solicitud puede editarla', 404: 'Solicitud no encontrada',
      409: 'La solicitud ya no está pendiente u otra solicitud pendiente tiene la placa',
    },
  },
  {
    metodo: 'post', ruta: '/api/solicitudes-acceso/:id(\\d+)/aprobar', etiqueta: 'Solicitudes de acceso',
    acceso: ['solicitudes:resolver', 'padron:gestionar'],
    resumen: 'Aprueba una solicitud (crea, reactiva o amplía el permiso)',
    descripcion: 'Separación de funciones: quien registró la solicitud no puede resolverla. Admite ajustes de los datos del permiso; '
      + 'el permiso resultante se valida con las mismas reglas de la lista blanca que un alta directa. Responde '
      + '{ message, solicitud, permiso } y queda en la auditoría (SOLICITUD_APROBADA). Control de concurrencia optimista: se '
      + 'indica la versión revisada; si el solicitante la editó mientras tanto, responde 409 y no concede el permiso.',
    cuerpo: {
      version: { tipo: 'integer', requerido: true, descripcion: 'Versión de la solicitud que revisó el gestor (campo version del listado)', ejemplo: 1 },
      comentario: { tipo: 'string', descripcion: 'Texto libre sin < >, máximo 300 caracteres' },
      ajustes: {
        tipo: 'object',
        descripcion: 'Ajustes opcionales: propietario, departamento, categoria, tipo_vehiculo, marca, modelo, color, observaciones, fecha_inicio, fecha_fin, horario',
        ejemplo: { fecha_fin: '2026-10-31', categoria: 'PROVEEDOR' },
      },
    },
    respuestas: {
      400: 'Versión, comentario, ajustes o identificador inválidos', 403: 'Separación de funciones: solicitud propia',
      404: 'Solicitud no encontrada', 409: 'La solicitud ya fue resuelta o cambió mientras se revisaba',
    },
  },
  {
    metodo: 'post', ruta: '/api/solicitudes-acceso/:id(\\d+)/rechazar', etiqueta: 'Solicitudes de acceso', acceso: 'solicitudes:resolver',
    resumen: 'Rechaza una solicitud con un comentario',
    descripcion: 'Separación de funciones: quien registró la solicitud no puede resolverla.',
    cuerpo: { comentario: { tipo: 'string', requerido: true, descripcion: 'Motivo del rechazo, texto libre sin < > (5 a 300 caracteres)', ejemplo: 'No se justifica el ingreso' } },
    respuestas: {
      400: 'Motivo del rechazo (5 a 300, sin < >) o identificador inválidos', 403: 'Separación de funciones: solicitud propia',
      404: 'Solicitud no encontrada', 409: 'La solicitud ya fue resuelta',
    },
  },
  {
    metodo: 'post', ruta: '/api/solicitudes-acceso/:id(\\d+)/cancelar', etiqueta: 'Solicitudes de acceso', acceso: 'sesion',
    resumen: 'Cancela una solicitud propia pendiente',
    respuestas: { 400: 'Identificador inválido', 404: 'No hay una solicitud pendiente propia con ese número' },
  },
];
