import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export function initSocket(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*', // Permitir cualquier origen en entorno de desarrollo/tesis
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Cliente conectado: ${socket.id}`);
    
    socket.on('disconnect', () => {
      console.log(`[Socket] Cliente desconectado: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('[Socket] Socket.io no ha sido inicializado.');
  }
  return io;
}

export function emitEvent(channel: string, data: any) {
  if (io) {
    io.emit(channel, data);
  } else {
    console.warn(`[Socket] Intentando emitir a ${channel} pero io no está inicializado.`);
  }
}
