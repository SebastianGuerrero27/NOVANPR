import type { Vigencia } from './horario';

/**
 * Política de decisión de acceso (función pura).
 *
 * Toma las evidencias de un paso vehicular —coincidencia con la lista de alertas, permiso del
 * padrón y su estado temporal, validez/confianza de la lectura y verificación del vehículo— y
 * devuelve el estado del paso con las razones. Separar la política del transporte (HTTP, SQL)
 * permite probarla exhaustivamente con una tabla de decisión y citarla en el artículo como un
 * algoritmo verificable.
 *
 * Principio rector: los dos errores tienen costos asimétricos.
 *   - Falso "autorizado" (dejar pasar a quien no debe): costo alto → la autorización
 *     automática exige coincidencia EXACTA con un permiso vigente y una lectura que cumpla el
 *     criterio de evidencia configurado; ante la duda, decide una persona.
 *   - Falsa "alerta" (molestar a un vehículo legítimo): costo bajo → la lista de alertas se
 *     cruza con tolerancia a homoglifos del OCR y una alerta nunca se rebaja.
 *
 * Tabla de decisión (se evalúa en orden; la primera regla que aplica decide):
 *
 *   R1  coincide con lista de alertas (exacta o aproximada)            → alerta
 *   R2  permiso existe pero no está vigente (horario, inicio, vencido) → no_reconocido + restricción
 *          (salvo excepción autorizada por una persona con permiso accesos:excepcion → autorizado)
 *   R3  permiso vigente, decisión automática, lectura no cumple el criterio → pendiente_revision
 *   R4  permiso vigente, decisión automática, vehículo observado ≠ registrado (si se verifica)
 *                                                                       → pendiente_revision
 *   R5  permiso vigente                                                → autorizado
 *   R6  sin permiso, decisión automática y lectura marcada inválida    → pendiente_revision
 *          (podría ser una placa autorizada mal leída: no se alarma)
 *   R7  sin permiso                                                    → no_reconocido
 */

export type EstadoValidacion = 'autorizado' | 'alerta' | 'no_reconocido' | 'pendiente_revision';
export type RestriccionAcceso = Exclude<Vigencia, 'vigente'>;
export type CriterioAutorizacion = 'validez_y_confianza' | 'validez' | 'confianza';
export type FuenteConfianza = 'ocr' | 'deteccion' | 'ambas';

export interface PoliticaAutorizacion {
  criterio: CriterioAutorizacion;
  /** 0–1 */
  confianzaMinima: number;
  fuenteConfianza: FuenteConfianza;
  verificarVehiculo: boolean;
}

export interface EvidenciasLectura {
  /** Veredicto del motor (null si no lo informó) */
  lecturaValida: boolean | null;
  confianzaOcr: number | null;
  confianzaDeteccion: number | null;
}

export interface EntradaDecision {
  origen: 'automatico' | 'manual';
  alerta: { id: number; coincidencia: 'exacta' | 'aproximada' } | null;
  permiso: { id: number; vigencia: Vigencia } | null;
  lectura?: EvidenciasLectura;
  verificacionVehiculo?: 'coincide' | 'no_coincide' | 'sin_datos' | null;
  /** Solo en validación manual: una persona autorizada concede el paso pese a la restricción */
  excepcion?: boolean;
  politica: PoliticaAutorizacion;
}

export interface Decision {
  estado: EstadoValidacion;
  regla: 'R1' | 'R2' | 'R2-excepcion' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
  restriccion: RestriccionAcceso | null;
  motivos: string[];
}

/** Confianza evaluada según la fuente configurada (la menor si se exigen ambas). */
export function confianzaEvaluada(l: EvidenciasLectura, fuente: FuenteConfianza): number {
  const valores = fuente === 'deteccion' ? [l.confianzaDeteccion] : fuente === 'ambas' ? [l.confianzaOcr, l.confianzaDeteccion] : [l.confianzaOcr];
  return Math.min(...valores.map(v => (typeof v === 'number' ? v : 0)));
}

/**
 * ¿La lectura cumple el criterio de evidencia para autorizar sin intervención?
 * Si el motor no informó la validez, solo se evalúa la confianza.
 */
export function cumpleCriterioLectura(l: EvidenciasLectura, p: PoliticaAutorizacion) {
  const evaluada = confianzaEvaluada(l, p.fuenteConfianza);
  const conValidez = typeof l.lecturaValida === 'boolean' && p.criterio !== 'confianza';
  const validezOk = !conValidez || l.lecturaValida === true;
  const confianzaOk = p.criterio === 'validez' && conValidez ? true : evaluada >= p.confianzaMinima;
  return { cumple: validezOk && confianzaOk, validezOk, confianzaOk, evaluada, minimo: p.confianzaMinima, criterio: p.criterio };
}

export function decidirAcceso(e: EntradaDecision): Decision {
  // R1 · Las alertas nunca se rebajan
  if (e.alerta) {
    return {
      estado: 'alerta', regla: 'R1', restriccion: null,
      motivos: [e.alerta.coincidencia === 'exacta' ? 'Placa en la lista de alertas' : 'Lectura aproximada a una placa de la lista de alertas'],
    };
  }

  if (e.permiso) {
    // R2 · Permiso existente fuera de su ventana temporal
    if (e.permiso.vigencia !== 'vigente') {
      const restriccion = e.permiso.vigencia;
      if (e.origen === 'manual' && e.excepcion) {
        return { estado: 'autorizado', regla: 'R2-excepcion', restriccion, motivos: ['Ingreso autorizado por excepción'] };
      }
      return { estado: 'no_reconocido', regla: 'R2', restriccion, motivos: [MOTIVO_RESTRICCION[restriccion]] };
    }
    if (e.origen === 'automatico') {
      // R3 · Evidencia de lectura insuficiente para una decisión sin personas
      const c = cumpleCriterioLectura(e.lectura ?? { lecturaValida: null, confianzaOcr: null, confianzaDeteccion: null }, e.politica);
      if (!c.cumple) {
        const motivos: string[] = [];
        if (!c.validezOk) motivos.push('lectura no confirmada por el motor');
        if (!c.confianzaOk) motivos.push(`confianza ${(c.evaluada * 100).toFixed(1)} % < ${(c.minimo * 100).toFixed(0)} %`);
        return { estado: 'pendiente_revision', regla: 'R3', restriccion: null, motivos };
      }
      // R4 · Segundo factor: el vehículo observado no coincide con el registrado
      if (e.politica.verificarVehiculo && e.verificacionVehiculo === 'no_coincide') {
        return { estado: 'pendiente_revision', regla: 'R4', restriccion: null, motivos: ['vehículo observado distinto al registrado'] };
      }
    }
    // R5
    return { estado: 'autorizado', regla: 'R5', restriccion: null, motivos: ['Permiso vigente'] };
  }

  // R6 · Posible error de lectura de una placa autorizada
  if (e.origen === 'automatico' && e.lectura?.lecturaValida === false) {
    return { estado: 'pendiente_revision', regla: 'R6', restriccion: null, motivos: ['lectura no confirmada; podría ser una placa del padrón mal leída'] };
  }
  // R7
  return { estado: 'no_reconocido', regla: 'R7', restriccion: null, motivos: ['Sin permiso de ingreso'] };
}

export const MOTIVO_RESTRICCION: Record<RestriccionAcceso, string> = {
  fuera_horario: 'Permiso fuera de su horario autorizado',
  no_iniciada: 'El permiso aún no entra en vigencia',
  vencida: 'El permiso está vencido',
};
