import React, { useCallback, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { ContextoNotificar, type TipoAviso as Tipo } from '../../aplicacion/notificar';

export { useNotificar } from '../../aplicacion/notificar';

interface Toast { id: number; tipo: Tipo; titulo: string; texto?: string; alClic?: () => void }

const ICONOS = { info: Info, exito: CheckCircle2, error: AlertCircle, advertencia: AlertTriangle };
const COLOR = { info: '#93c5fd', exito: '#86efac', error: '#fca5a5', advertencia: '#fcd34d' };

let siguiente = 1;

export const NotificacionesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const cerrar = (id: number) => setToasts(t => t.filter(x => x.id !== id));
  const notificar = useCallback((tipo: Tipo, titulo: string, texto?: string, alClic?: () => void) => {
    const id = siguiente++;
    setToasts(t => [...t.slice(-3), { id, tipo, titulo, texto, alClic }]);
    window.setTimeout(() => cerrar(id), tipo === 'error' ? 7000 : 4500);
  }, []);
  return (
    <ContextoNotificar.Provider value={notificar}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => {
          const Icono = ICONOS[t.tipo];
          return (
            <div key={t.id} className={`toast ${t.tipo}`} role={t.tipo === 'error' ? 'alert' : 'status'}>
              <Icono size={18} color={COLOR[t.tipo]} style={{ flexShrink: 0, marginTop: 1 }} />
              {t.alClic
                ? <button className="toast-cuerpo" onClick={() => { cerrar(t.id); t.alClic!(); }} title="Abrir"><strong>{t.titulo}</strong>{t.texto && <span>{t.texto}</span>}</button>
                : <div><strong>{t.titulo}</strong>{t.texto && <span>{t.texto}</span>}</div>}
              <button onClick={() => cerrar(t.id)} aria-label="Cerrar notificación"><X size={14} /></button>
            </div>
          );
        })}
      </div>
    </ContextoNotificar.Provider>
  );
};

