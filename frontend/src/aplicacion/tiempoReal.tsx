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
}

const TiempoRealContext = createContext<Ctx>({ socket: null, conectado: false });

export const TiempoRealProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [conectado, setConectado] = useState(false);

  useEffect(() => {
    if (!token) return;
    const s = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
    });
    s.on('connect', () => setConectado(true));
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

  return <TiempoRealContext.Provider value={{ socket, conectado }}>{children}</TiempoRealContext.Provider>;
};

export const useTiempoReal = () => useContext(TiempoRealContext);

/** Suscribe un manejador a un evento; el manejador puede cambiar entre renders sin resuscribir. */
export function useEvento<T = any>(evento: string, manejador: (datos: T) => void) {
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
