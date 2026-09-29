import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { verificarTokenSocket } from '../middlewares/auth';
import { origenesPermitidos } from './origenes';

/**
 * Canal de tiempo real (Socket.IO). Solo acepta clientes con una sesión válida: el token
 * se envía en el handshake (`auth.token`) y se verifica igual que en la API REST.
 */
let io: SocketIOServer | null = null;

export function initSocket(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: { origin: origenesPermitidos(), methods: ['GET', 'POST'] },
  });

  io.use(async (socket, next) => {
    const user = await verificarTokenSocket(socket.handshake.auth?.token);
    if (!user) return next(new Error('no_autorizado'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    socket.join(`rol:${socket.data.user.rol}`);
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('[Socket] Socket.io no ha sido inicializado.');
  }
  return io;
}

/** Difunde a todas las sesiones conectadas. */
export function emitEvent(channel: string, data: any) {
  if (io) io.emit(channel, data);
}

/** Difunde solo a los roles indicados (p. ej. eventos administrativos). */
export function emitirARoles(roles: string[], channel: string, data: any) {
  if (io) io.to(roles.map(r => `rol:${r}`)).emit(channel, data);
}
