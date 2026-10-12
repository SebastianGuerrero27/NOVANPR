import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_URL } from '../infraestructura/api';
import { useAuth } from './AuthContext';

/**
 * Una sola conexión Socket.IO por sesión (autenticada con el JWT en el handshake), compartida
 * por todas las pantallas. Las pantallas se suscriben a eventos con useEvento en lugar de
 * consultar la API periódicamente.
 */
interface Ctx {
  socket: Socket | null;
  conectado: boolean;
  /** Veces que la conexión volvió tras caerse (los eventos de ese intervalo se perdieron) */
  reconexiones: number;
}

/** Exportado para las pruebas (en la aplicación se usa a través de TiempoRealProvider). */
export const TiempoRealContext = createContext<Ctx>({ socket: null, conectado: false, reconexiones: 0 });

export const TiempoRealProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [conectado, setConectado] = useState(false);
  const [reconexiones, setReconexiones] = useState(0);

  useEffect(() => {
    if (!token) return;
    let conectadoAntes = false;
    const s = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
    });
    s.on('connect', () => {
      setConectado(true);
      if (conectadoAntes) setReconexiones(n => n + 1);
      conectadoAntes = true;
    });
    s.on('disconnect', () => setConectado(false));
    s.on('connect_error', () => setConectado(false));
    setSocket(s);
    return () => {
      s.removeAllListeners();
      s.disconnect();
      setSocket(null);
      setConectado(false);
    };
  }, [token]);

  return <TiempoRealContext.Provider value={{ socket, conectado, reconexiones }}>{children}</TiempoRealContext.Provider>;
};

export const useTiempoReal = () => useContext(TiempoRealContext);

/**
 * Ejecuta `alReconectar` cuando la conexión en tiempo real vuelve tras una caída. Socket.IO no
 * reenvía los eventos emitidos mientras el navegador estaba desconectado: la pantalla vuelve a
 * consultar la API (la fuente de verdad es la base de datos) para no quedar desactualizada.
 */
export function useReconexion(alReconectar: () => void) {
  const { reconexiones } = useTiempoReal();
  const ref = useRef(alReconectar);
  ref.current = alReconectar;
  // Solo cuentan las reconexiones ocurridas con la pantalla abierta: al montarse ya pide sus datos
  const atendidas = useRef(reconexiones);
  useEffect(() => {
    if (reconexiones > atendidas.current) {
      atendidas.current = reconexiones;
      ref.current();
    }
  }, [reconexiones]);
}

/** Suscribe un manejador a un evento; el manejador puede cambiar entre renders sin resuscribir. */
export function useEvento<T = unknown>(evento: string, manejador: (datos: T) => void) {
  const { socket } = useTiempoReal();
  const ref = useRef(manejador);
  ref.current = manejador;
  useEffect(() => {
    if (!socket) return;
    const fn = (d: T) => ref.current(d);
    socket.on(evento, fn);
    return () => { socket.off(evento, fn); };
  }, [socket, evento]);
}
