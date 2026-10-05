import type { DeteccionDTO, Fila } from '../aplicacion/detecciones';
import type { EstadoValidacion, RestriccionAcceso } from '../dominio/decisionAcceso';
import { evidenciaDe, motivoRevision, type PasoGuardado } from '../dominio/detecciones';
import { politicaAutorizacion } from './servicios/configuracion';
import { urlMedia } from './servicios/media';

/**
 * Representación única de una detección para la API y los eventos en tiempo real. Las imágenes
 * se entregan con URL firmada y temporal (infraestructura/servicios/media.ts) y el motivo de revisión se explica
 * con la política de autorización vigente (dominio/detecciones.ts).
 */
export function presentarDeteccion(d: Fila, detalle = false): DeteccionDTO {
  const base = {
    id: d.id,
    placa: d.placa_validada || d.placa_reconocida || null,
    placa_reconocida: d.placa_reconocida ?? null,
    placa_validada: d.placa_validada ?? null,
    estado_validacion: d.estado_validacion as EstadoValidacion,
    estado_procesamiento: d.estado_procesamiento,
    confianza_deteccion: d.confianza_deteccion,
    confianza_ocr: d.confianza_ocr,
    fecha_hora_ingreso: d.fecha_hora_ingreso,
    fecha_hora_procesamiento: d.fecha_hora_procesamiento,
    fuente: d.fuente,
    tracking_id: d.tracking_id,
    imagen_vehiculo: urlMedia(d.ruta_imagen_ingreso),
    imagen_placa: urlMedia(d.ruta_imagen_placa || d.ruta_imagen_ingreso),
    camara: d.camara_id ? { id: d.camara_id, nombre: d.camara_nombre, ubicacion: d.camara_ubicacion } : null,
    tipo_vehiculo: d.tipo_vehiculo || d.autorizado_tipo || d.vehiculo_tipo || null,
    vehiculo: { tipo: d.vehiculo_tipo, marca: d.vehiculo_marca, modelo: d.vehiculo_modelo, color: d.vehiculo_color },
    verificacion_vehiculo: d.verificacion_vehiculo ?? null,
    verificacion_detalle: d.verificacion_detalle ?? null,
    alerta: d.alerta_id ? { id: d.alerta_id, motivo: d.alerta_motivo, nivel: d.nivel_alerta } : null,
    autorizado: d.vehiculo_autorizado_id
      ? { id: d.vehiculo_autorizado_id, propietario: d.propietario, departamento: d.departamento, categoria: d.autorizado_categoria ?? null } : null,
    restriccion_acceso: (d.restriccion_acceso ?? null) as RestriccionAcceso | null,
    validado_manualmente: Boolean(d.validado_manualmente),
    lectura_valida: d.lectura_valida === null || d.lectura_valida === undefined ? null : Boolean(d.lectura_valida),
    motivo_revision: motivoRevision(d as PasoGuardado, politicaAutorizacion()),
    validacion: d.validado_manualmente
      ? { usuario: d.validador_nombre ? { id: d.usuario_validador_id, nombre: d.validador_nombre, email: d.validador_email } : null, fecha: d.fecha_validacion }
      : null,
  };
  if (!detalle) return base;
  return {
    ...base,
    lectura_automatica: {
      placa: d.placa_ocr_original, confianza: d.confianza_ocr_original, decision: d.decision_automatica,
      verificador: d.lectura_verificador, latencia_ms: d.latencia_ms,
      modelo_detector: d.modelo_detector, modelo_ocr: d.modelo_ocr,
      valida: d.lectura_valida === null || d.lectura_valida === undefined ? null : Boolean(d.lectura_valida),
      evidencia: evidenciaDe(d),
    },
    captura: {
      luminancia_media: d.luminancia_media, distancia_estimada_m: d.distancia_estimada_m,
      ancho_placa_px: d.ancho_placa_px, nitidez: d.nitidez, velocidad_px_s: d.velocidad_px_s,
      condicion_clima: d.condicion_clima,
    },
  };
}
