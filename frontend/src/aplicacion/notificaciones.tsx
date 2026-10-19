import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../infraestructura/api';
import { useAuth } from './AuthContext';
import { useEvento, useTiempoReal } from './tiempoReal';
import { useDiferido } from './hooks';
import { sonarAviso } from '../infraestructura/avisos';
import { registrarServiceWorker, sincronizarPush } from '../infraestructura/push';
import { useNotificar } from './notificar';
import type { Notificacion } from '../dominio/tipos';

/**
 * Estado del centro de notificaciones de la sesión.
 *
 * Entrega "al menos una vez": la bandeja se carga por REST al iniciar y cada vez que el
 * Socket.IO reconecta (recupera lo emitido mientras no hubo conexión); los eventos en vivo
 * (`notificacion:nueva | actualizada`) se fusionan por id, así que un duplicado no se muestra
 * dos veces. El reconocimiento (ACK) se registra en el backend y se difunde a todos los
 * destinatarios de la alarma. Cada persona puede quitar de su bandeja las notificaciones ya
 * revisadas (`notificacion:eliminada` sincroniza sus otras pestañas y equipos).
 */
interface Ctx {
  items: Notificacion[];
  noLeidas: number;
  pendientes: number;
  /** Revisadas (leídas y sin alarma pendiente): las que se pueden quitar de la bandeja */
  revisadas: number;
  cargando: boolean;
  hayMas: boolean;
  recargar: () => Promise<void>;
  cargarMas: () => Promise<void>;
  marcarLeida: (id: number) => Promise<void>;
  marcarTodas: () => Promise<void>;
  reconocer: (id: number) => Promise<void>;
  reconocerDeteccion: (deteccionId: number) => Promise<void>;
  /** Quita una notificación revisada de la bandeja propia */
  eliminar: (id: number) => Promise<void>;
  /** Quita todas las revisadas; devuelve el mensaje del servidor */
  eliminarRevisadas: () => Promise<string>;
}

interface Resumen { no_leidas: number; pendientes: number; revisadas: number }
const RESUMEN_VACIO: Resumen = { no_leidas: 0, pendientes: 0, revisadas: 0 };
const resumenDe = (d: Partial<Resumen>): Resumen => ({ no_leidas: d.no_leidas ?? 0, pendientes: d.pendientes ?? 0, revisadas: d.revisadas ?? 0 });

const CentroContext = createContext<Ctx | null>(null);
const LIMITE = 30;
const MAX_EN_MEMORIA = 200;

function fusionar(lista: Notificacion[], nuevas: Partial<Notificacion>[]): Notificacion[] {
  const porId = new Map(lista.map(n => [n.id, n]));
  for (const n of nuevas) {
    if (n.id === undefined) continue;
    const previa = porId.get(n.id);
    porId.set(n.id, previa ? { ...previa, ...n } : (n as Notificacion));
  }
  return [...porId.values()].sort((a, b) => b.id - a.id).slice(0, MAX_EN_MEMORIA);
}

const TIPO_TOAST = { critica: 'error', alta: 'advertencia', media: 'info', baja: 'info' } as const;

/** Alarma que exige atención y nadie atendió ni se resolvió */
export const pendienteDeAtencion = (n: Notificacion) => n.requiere_ack && !n.atendida && !n.resuelta;

/** Revisada: leída y sin alarma pendiente. Solo esas se pueden quitar de la bandeja (como en el backend). */
export const esRevisada = (n: Notificacion) => n.leida && !pendienteDeAtencion(n);

export const CentroNotificacionesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, puede } = useAuth();
  const { conectado } = useTiempoReal();
  const notificar = useNotificar();
  const navigate = useNavigate();
  const [items, setItems] = useState<Notificacion[]>([]);
  const [resumen, setResumen] = useState<Resumen>(RESUMEN_VACIO);
  const [cargando, setCargando] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const conectadoAntes = useRef(false);

  const recargar = useCallback(async () => {
    if (!token) return;
    setCargando(true);
    try {
      const { data } = await api.get('/notificaciones', { params: { limite: LIMITE } });
      setItems(actuales => fusionar(actuales, data.items));
      setResumen(resumenDe(data));
      setHayMas(data.items.length === LIMITE);
    } catch { /* se reintenta al reconectar */ } finally {
      setCargando(false);
    }
  }, [token]);

  const cargarResumen = useCallback(() => {
    api.get('/notificaciones/resumen').then(r => setResumen(resumenDe(r.data))).catch(() => undefined);
  }, []);
  const resumenDiferido = useDiferido(cargarResumen, 700);

  const cargarMas = useCallback(async () => {
    const menor = items.length ? items[items.length - 1].id : undefined;
    const { data } = await api.get('/notificaciones', { params: { limite: LIMITE, antes_de: menor } });
    setItems(actuales => fusionar(actuales, data.items));
    setHayMas(data.items.length === LIMITE);
  }, [items]);

  // Sesión nueva: bandeja limpia, service worker y suscripción push vinculada a esta cuenta
  useEffect(() => {
    setItems([]);
    setResumen(RESUMEN_VACIO);
    if (!token) return;
    void recargar();
    registrarServiceWorker()?.catch(() => undefined);
    void sincronizarPush();
  }, [token, recargar]);

  // Recuperación tras un corte de la conexión de tiempo real
  useEffect(() => {
    if (conectado && !conectadoAntes.current && token) void recargar();
    conectadoAntes.current = conectado;
  }, [conectado, token, recargar]);

  // Mensajes del service worker: clic en una notificación del sistema operativo
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const fn = (e: MessageEvent) => { if (e.data?.tipo === 'anpr:navegar' && e.data.enlace) navigate(e.data.enlace); };
    navigator.serviceWorker.addEventListener('message', fn);
    return () => navigator.serviceWorker.removeEventListener('message', fn);
  }, [navigate]);

  useEvento<Notificacion>('notificacion:nueva', n => {
    setItems(actuales => fusionar(actuales, [n]));
    resumenDiferido();
    // Las alertas que ya tienen protocolo a pantalla completa no duplican el toast.
    // El ingreso autorizado no tiene ese protocolo: debe avisarse también como toast.
    const garita = puede('avisos:garita') && n.tipo.startsWith('acceso.')
      && n.tipo !== 'acceso.reincidencia' && n.tipo !== 'acceso.llegada_permiso';
    if (!garita) {
      // Pulsar el aviso abre su enlace (p. ej. la lista blanca filtrada por la placa del permiso otorgado)
      notificar(TIPO_TOAST[n.severidad], n.titulo, n.mensaje, n.enlace ? () => navigate(n.enlace!) : undefined);
      if (n.severidad === 'critica' || n.severidad === 'alta') sonarAviso();
    }
    // Pestaña oculta sin push: notificación local del sistema operativo
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
      registrarServiceWorker()?.then(r => r.pushManager.getSubscription().then(s => {
        if (!s) void r.showNotification(n.titulo, { body: n.mensaje, tag: `anpr-${n.id}`, icon: '/icono-anpr.png', data: { enlace: n.enlace } });
      })).catch(() => undefined);
    }
  });
  useEvento<Partial<Notificacion>>('notificacion:actualizada', n => {
    setItems(actuales => fusionar(actuales, [n]));
    resumenDiferido();
  });
  // Quitadas desde otra pestaña o equipo de la misma cuenta
  useEvento<{ ids: number[] }>('notificacion:eliminada', ({ ids }) => {
    const quitar = new Set(ids);
    setItems(actuales => actuales.filter(n => !quitar.has(n.id)));
    resumenDiferido();
  });

  const marcarLeida = useCallback(async (id: number) => {
    setItems(a => a.map(n => (n.id === id ? { ...n, leida: true } : n)));
    const { data } = await api.post(`/notificaciones/${id}/leer`);
    setResumen(resumenDe(data));
  }, []);

  const marcarTodas = useCallback(async () => {
    setItems(a => a.map(n => ({ ...n, leida: true })));
    const { data } = await api.post('/notificaciones/leer-todas');
    setResumen(resumenDe(data));
  }, []);

  const reconocer = useCallback(async (id: number) => {
    const { data } = await api.post(`/notificaciones/${id}/reconocer`);
    setItems(a => a.map(n => (n.id === id ? { ...n, leida: true } : n)));
    setResumen(resumenDe(data));
  }, []);

  const reconocerDeteccion = useCallback(async (deteccionId: number) => {
    const { data } = await api.post(`/notificaciones/reconocer-deteccion/${deteccionId}`);
    setResumen(resumenDe(data));
  }, []);

  const eliminar = useCallback(async (id: number) => {
    const { data } = await api.delete(`/notificaciones/${id}`);
    setItems(a => a.filter(n => n.id !== id));
    setResumen(resumenDe(data));
  }, []);

  // El servidor quita también las revisadas que aún no se cargaron en esta pantalla
  const eliminarRevisadas = useCallback(async () => {
    const { data } = await api.delete('/notificaciones/revisadas');
    setItems(a => a.filter(n => !n.leida || pendienteDeAtencion(n)));
    setResumen(resumenDe(data));
    return String(data.message ?? '');
  }, []);

  const valor = useMemo<Ctx>(() => ({
    items, noLeidas: resumen.no_leidas, pendientes: resumen.pendientes, revisadas: resumen.revisadas, cargando, hayMas,
    recargar, cargarMas, marcarLeida, marcarTodas, reconocer, reconocerDeteccion, eliminar, eliminarRevisadas,
  }), [items, resumen, cargando, hayMas, recargar, cargarMas, marcarLeida, marcarTodas, reconocer, reconocerDeteccion, eliminar, eliminarRevisadas]);

  return <CentroContext.Provider value={valor}>{children}</CentroContext.Provider>;
};

export function useCentroNotificaciones(): Ctx {
  const c = useContext(CentroContext);
  if (!c) throw new Error('useCentroNotificaciones debe usarse dentro de CentroNotificacionesProvider');
  return c;
}
