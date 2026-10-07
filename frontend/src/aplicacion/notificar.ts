import { createContext, useContext } from 'react';

/**
 * Avisos emergentes (toasts): la capa de aplicación solo conoce este contrato; el componente
 * interfaz/componentes/Notificaciones.tsx lo implementa y los muestra.
 */
export type TipoAviso = 'info' | 'exito' | 'error' | 'advertencia';

/** `alClic`: acción al pulsar el aviso (p. ej. abrir el enlace de una notificación) */
export type Notificar = (tipo: TipoAviso, titulo: string, texto?: string, alClic?: () => void) => void;

export const ContextoNotificar = createContext<Notificar>(() => undefined);

export const useNotificar = () => useContext(ContextoNotificar);
