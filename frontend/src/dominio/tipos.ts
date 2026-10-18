/** Contratos de la API (espejo de los mapeadores del backend). */
import type { Rol } from './permisos';

export type EstadoValidacion = 'autorizado' | 'alerta' | 'no_reconocido' | 'pendiente_revision' | 'salida_registrada';
export type EstadoProcesamiento = 'pendiente_ocr' | 'procesado' | 'no_legible';
export type RestriccionAcceso = 'fuera_horario' | 'no_iniciada' | 'vencida';

/** Franja horaria de un permiso (días ISO 8601: 1 = lunes … 7 = domingo) */
export interface Franja { dias: number[]; desde: string; hasta: string }

export interface Deteccion {
  id: number;
  placa: string | null;
  placa_reconocida: string | null;
  placa_validada: string | null;
  estado_validacion: EstadoValidacion;
  estado_procesamiento: EstadoProcesamiento;
  confianza_deteccion: number | null;
  confianza_ocr: number | null;
  fecha_hora_ingreso: string;
  tipo_movimiento: 'ingreso' | 'salida';
  fecha_hora_procesamiento: string | null;
  fuente: string | null;
  tracking_id: number | null;
  imagen_vehiculo: string | null;
  imagen_placa: string | null;
  camara: { id: number; nombre: string; ubicacion: string } | null;
  tipo_vehiculo: string | null;
  vehiculo: { tipo: string | null; marca: string | null; modelo: string | null; color: string | null };
  verificacion_vehiculo: 'coincide' | 'no_coincide' | 'sin_datos' | null;
  verificacion_detalle: string | null;
  alerta: { id: number; motivo: string; nivel: 'CRITICA' | 'ALTA' | 'MEDIA' } | null;
  autorizado: { id: number; propietario: string; departamento: string | null; categoria?: string | null } | null;
  /** Permiso existente que no concedió el paso: fuera de horario, aún no vigente o vencido */
  restriccion_acceso?: RestriccionAcceso | null;
  validado_manualmente: boolean;
  /** Veredicto del motor: la lectura cumple todas las evidencias (null si no lo informó) */
  lectura_valida?: boolean | null;
  /** Por qué un paso quedó pendiente (lectura no confirmada, confianza baja o vehículo distinto) */
  motivo_revision?: string | null;
  validacion: { usuario: { id: number; nombre: string; email: string } | null; fecha: string } | null;
}

export interface DeteccionDetalle extends Deteccion {
  lectura_automatica: {
    placa: string | null; confianza: number | null; decision: string | null; verificador: string | null;
    latencia_ms: number | null; modelo_detector: string | null; modelo_ocr: string | null;
    valida: boolean | null;
    evidencia: EvidenciaLectura | null;
  };
  captura: {
    luminancia_media: number | null; distancia_estimada_m: number | null; ancho_placa_px: number | null;
    nitidez: number | null; velocidad_px_s: number | null; condicion_clima: string | null;
  };
  auditoria: { fecha: string; accion: string; usuario_email: string | null; detalle: string | null }[];
  pasos_anteriores: Deteccion[];
}

/** Evidencias con que el motor decide si una lectura es válida (ver verificacion_placa.py) */
export interface EvidenciaLectura {
  valido: boolean;
  formato: boolean;
  dentro_cuadro: boolean;
  caracteres: number;
  lecturas: number;
  verificador_coincide: boolean;
  motivos: string[];
  angulo?: number;
  regularidad?: number;
  bordes_hallados?: number;
  lectura_ocr?: string | null;
  lectura_verificador?: string | null;
  /** Caracteres de la placa que ningún lector leyó tal cual (salieron de una sustitución): [posición, carácter] */
  caracteres_inferidos?: [number, string][];
  /** Salida cruda de cada lector, antes de interpretar confusiones (0↔O, 5↔S…) */
  lectura_ocr_cruda?: string | null;
  lectura_verificador_cruda?: string | null;
  lecturas_rapidas_crudas?: string[] | null;
}

export interface Pagina<T> {
  items: T[];
  total: number;
  pagina: number;
  tamano: number;
}

export interface Camara {
  id: number;
  nombre: string;
  ip: string;
  ubicacion: string;
  direccion: 'ingreso' | 'salida';
  rtsp_url: string;
  /** Flujo secundario para la vista en vivo (contraseña enmascarada); null: la vista usa el principal */
  rtsp_url_vista: string | null;
  tiene_credenciales: boolean;
  activa: boolean;
  estado: 'EN_LINEA' | 'SIN_CONEXION' | 'SIN_VERIFICAR';
  ultimo_ping: string | null;
  tiempo_respuesta_ms: number | null;
  mensaje_ping: string | null;
  created_at: string;
  detecciones?: number;
  /** Región de interés: vértices normalizados (0–1) o null para el cuadro completo */
  roi: [number, number][] | null;
  /** Zonas de exclusión (polígonos normalizados): ahí no cuenta el movimiento ni se buscan placas */
  exclusiones?: [number, number][][];
}

export interface Conteos {
  total: number;
  autorizados: number;
  alertas: number;
  no_registrados: number;
  pendientes: number;
}

export interface ResumenPanel {
  generado: string;
  hoy: Conteos & { validados: number };
  ayer_misma_hora: number;
  por_hora: (Conteos & { hora: number })[];
  tendencia: (Conteos & { fecha: string })[];
  camaras: { id: number; nombre: string; ubicacion: string; activa: boolean; estado: Camara['estado']; ultimo_ping: string | null; tiempo_respuesta_ms: number | null; detecciones_hoy: number }[];
  cola_revision: number;
  ultimas_alertas: Deteccion[];
  listas: { autorizados_vigentes: number; autorizados_por_vencer: number; autorizados_vencidos: number; alertas_vigentes: number; dias_aviso: number };
  exactitud_ocr: { validadas: number; correctas: number };
}

/** Enlace del motor con el flujo principal de la cámara (lo informa el lector RTSP del motor). */
export interface EnlaceVideo {
  codec: string | null;
  ancho: number | null;
  alto: number | null;
  fps_recibidos: number | null;
  reconexiones: number | null;
  ultimo_cuadro_hace_s: number | null;
}

/** Percentiles de una latencia del motor (ms), sobre sus últimas mediciones */
export interface PercentilesLatencia { p50_ms: number; p95_ms: number; max_ms: number; muestras: number }

/** Latencia de tiempo real desde la captura de cada cuadro (motor ANPR) */
export interface LatenciaMotor {
  /** Captura → inicio del análisis */
  edad_cuadro: PercentilesLatencia | null;
  /** Captura del cuadro leído → lectura en el HUD */
  lectura_en_vivo: PercentilesLatencia | null;
  /** Captura del mejor cuadro → lectura confirmada por el backend */
  registro: PercentilesLatencia | null;
  /** Cuadros de la cámara descartados porque llegó uno más nuevo (%) */
  cuadros_descartados_pct: number | null;
}

export interface EstadoAnpr {
  en_linea: boolean;
  fps_captura?: number;
  fps_procesamiento?: number;
  latencia?: LatenciaMotor | null;
  detector?: string | null;
  ocr?: string | null;
  verificador?: string | null;
  camara_activa?: { id: number; conectada: boolean } | null;
  enlace?: EnlaceVideo | null;
  /** true si el motor procesa una fuente que no corresponde a ninguna cámara registrada */
  fuente_externa?: boolean;
  error?: string;
}

export interface PanelAdministracion {
  usuarios: { total: number; activos: number; pendientes: number; inactivos: number; bloqueados: number; por_rol: Record<Rol, number> };
  accesos_24h: { exitosos: number; fallidos: number };
  ultimos_fallidos: { fecha: string; email: string; motivo: string; ip: string }[];
  actividad: { fecha: string; actor: string | null; accion: string; entidad: string; detalle: string | null }[];
  servicios: { base_datos: { en_linea: boolean }; anpr: EstadoAnpr; correo: { configurado: boolean } };
}

export interface RegistroLista {
  id: number;
  placa: string;
  marca: string | null;
  modelo: string | null;
  color: string | null;
  observaciones: string | null;
  fecha_vencimiento: string | null;
  fecha_registro: string;
  fecha_actualizacion: string | null;
  registrado_por_email: string | null;
  vigente: boolean;
  por_vencer: boolean;
  ingresos: number;
  // Autorizados (permisos de placa)
  propietario?: string;
  departamento?: string | null;
  tipo_vehiculo?: string | null;
  categoria?: string;
  fecha_inicio?: string | null;
  pendiente_inicio?: boolean;
  horario?: Franja[] | null;
  horario_texto?: string;
  // Alertas
  motivo?: string;
  nivel_alerta?: 'CRITICA' | 'ALTA' | 'MEDIA';
}

export interface UsuarioAdmin {
  id: number;
  email: string;
  nombre_completo: string;
  cargo: string | null;
  rol: Rol;
  rol_nombre: string;
  estado: 'pendiente' | 'activo' | 'inactivo';
  email_verificado: boolean;
  bloqueado: boolean;
  bloqueo_temporal_hasta: string | null;
  intentos_fallidos: number;
  fecha_ultimo_acceso: string | null;
  fecha_creacion: string;
  creado_por: string | null;
}

// ─── Centro de notificaciones ────────────────────────────────────────────────

export type Severidad = 'critica' | 'alta' | 'media' | 'baja';

export interface Notificacion {
  id: number;
  tipo: string;
  severidad: Severidad;
  titulo: string;
  mensaje: string;
  enlace: string | null;
  datos: Record<string, unknown> | null;
  repeticiones: number;
  requiere_ack: boolean;
  fecha_creacion: string;
  fecha_ultima: string;
  leida: boolean;
  atendida: { usuario: { id: number; nombre: string } | null; fecha: string } | null;
  resuelta: boolean;
  escalada: boolean;
}

export interface MetricasNotificacion {
  dias: number;
  por_severidad: {
    severidad: Severidad; emitidas: number; repeticiones_agrupadas: number; con_ack: number; reconocidas: number;
    escaladas: number; tta_mediana_s: number | null; tta_p95_s: number | null;
  }[];
  alarmas_por_hora: number;
  ventanas_avalancha_10min: number;
}

// ─── Solicitudes de acceso ───────────────────────────────────────────────────

export type EstadoSolicitud = 'pendiente' | 'aprobada' | 'rechazada' | 'cancelada';

export interface SolicitudAcceso {
  id: number;
  placa: string;
  propietario: string;
  departamento: string | null;
  categoria: string;
  motivo: string;
  vehiculo: { tipo: string | null; marca: string | null; modelo: string | null; color: string | null };
  fecha_inicio: string | null;
  fecha_fin: string | null;
  horario: Franja[] | null;
  horario_texto: string;
  deteccion_id: number | null;
  estado: EstadoSolicitud;
  solicitante: { id: number; nombre: string; email: string };
  fecha_solicitud: string;
  resolutor: { id: number; nombre: string } | null;
  fecha_resolucion: string | null;
  comentario_resolucion: string | null;
  vehiculo_autorizado_id: number | null;
  en_lista_alertas: boolean;
  permiso_actual_id: number | null;
  /** Versión de los datos: la aprobación indica la que revisó el gestor (si cambió, la API responde 409) */
  version: number;
}

export interface PanelAccesos {
  generado: string;
  solicitudes: { pendientes: number; ultimas: { id: number; placa: string; propietario: string; categoria: string; motivo: string; fecha_solicitud: string; solicitante: string }[] };
  padron: { vigentes: number; por_vencer: number; vencidos: number; por_iniciar: number; con_horario: number; dias_aviso: number };
  categorias: Record<string, number>;
  hoy: { sin_permiso: number; restringidos: number };
  reincidentes: { placa: string; intentos: number; ultimo: string }[];
  denegados_recientes: Deteccion[];
}
