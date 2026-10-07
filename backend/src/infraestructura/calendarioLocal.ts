import type { CalendarioLocal } from '../aplicacion/calendario';
import { desfaseMinutos, inicioDiaLocal } from './servicios/tiempo';

/** Calendario real: reloj del sistema y zona horaria configurada (ZONA_HORARIA). */
export const calendarioLocal: CalendarioLocal = {
  ahora: () => new Date(),
  inicioDiaLocal,
  desfaseMinutos,
};
