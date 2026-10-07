import { useCallback, useEffect, useRef, useState } from 'react';
import { mensajeError } from '../infraestructura/api';

/** true mientras la pestaña está visible (Page Visibility API). */
export function usePaginaVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const fn = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  }, []);
  return visible;
}

/**
 * Carga asíncrona con estado de carga/error y recarga manual. Descarta respuestas de
 * solicitudes anteriores si los parámetros cambian antes de que terminen.
 */
export function useConsulta<T>(cargar: () => Promise<T>, deps: unknown[] = []) {
  const [datos, setDatos] = useState<T | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const turno = useRef(0);

  const recargar = useCallback(async (silencioso = false) => {
    const mio = ++turno.current;
    if (!silencioso) setCargando(true);
    try {
      const r = await cargar();
      if (mio === turno.current) { setDatos(r); setError(null); }
    } catch (e) {
      if (mio === turno.current) setError(mensajeError(e));
    } finally {
      if (mio === turno.current) setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { recargar(); }, [recargar]);

  return { datos, setDatos, cargando, error, recargar };
}

/** Ejecuta `fn` como máximo una vez cada `ms` (el último llamado gana). */
export function useDiferido(fn: () => void, ms: number) {
  const t = useRef<number | undefined>(undefined);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => () => window.clearTimeout(t.current), []);
  return useCallback(() => {
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => ref.current(), ms);
  }, [ms]);
}

/** Valor que se actualiza `ms` después del último cambio (búsquedas). */
export function useRetardado<T>(valor: T, ms = 350): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = window.setTimeout(() => setV(valor), ms);
    return () => window.clearTimeout(t);
  }, [valor, ms]);
  return v;
}

/** Fuerza un re-render cada `ms` (relojes y tiempos relativos). */
export function useTic(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => set(x => x + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}
