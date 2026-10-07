/**
 * Puerto del calendario de la institución (zona horaria local). Los indicadores "de hoy" y las
 * series por día u hora se cuentan en hora de Ecuador aunque la base guarde las fechas en UTC.
 * Implementación: infraestructura/calendarioLocal.ts (infraestructura/servicios/tiempo.ts). Las pruebas usan un
 * calendario fijo para que los resultados no dependan del reloj.
 */
export interface CalendarioLocal {
  ahora(): Date;
  /** Instante UTC en que empieza el día local que contiene `fecha`, desplazado `dias` */
  inicioDiaLocal(fecha: Date, dias?: number): Date;
  /** Desfase de la zona en minutos (p. ej. -300 para UTC-5) */
  desfaseMinutos(fecha: Date): number;
}
