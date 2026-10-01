import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { alInvalidarCuenta, verificarTokenSocket } from '../middlewares/auth';
import { origenesPermitidos } from './origenes';
import { setWebSocketConnections } from './metrics';

/**
 * Canal de tiempo real (Socket.IO sobre WebSocket, RFC 6455).
 *
 * Es el equivalente en Node.js de ASP.NET Core SignalR: "hubs" ≈ espacios de nombres,
 * "groups" ≈ salas, reconexión automática con retroceso y "backplane" para varias instancias
 * ≈ adaptador de Redis (Redis ya forma parte del despliegue). Solo acepta sesiones válidas:
 * el JWT llega en el handshake (`auth.token`) y se verifica igual que en la API REST.
 *
 * Salas:
 *   usuario:{id}  notificaciones personales (bandeja, ACK, solicitudes resueltas)
 *   rol:{rol}     difusiones por rol
 * Al cambiar el rol o bloquear una cuenta se cierran sus conexiones para que reconecte con
 * las salas correctas (o sea rechazada).
 */
let io: SocketIOServer | null = null;

async function adaptadorRedis(servidor: SocketIOServer): Promise<void> {
  const activo = process.env.SOCKET_REDIS_ADAPTER
    ? process.env.SOCKET_REDIS_ADAPTER === 'true'
    : process.env.ENABLE_REDIS_CACHE === 'true';
  if (!activo) return;
  const opciones = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  };
  const pub = new Redis(opciones);
  const sub = pub.duplicate();
  try {
    await Promise.race([
      Promise.all([pub.connect(), sub.connect()]),
      new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo de espera agotado')), 3000)),
    ]);
    pub.on('error', e => console.warn('[SOCKET] Redis (pub):', e.message));
    sub.on('error', e => console.warn('[SOCKET] Redis (sub):', e.message));
    servidor.adapter(createAdapter(pub, sub));
    console.log('[SOCKET] Adaptador Redis activo: los eventos se reparten entre instancias del backend.');
  } catch (e: any) {
    pub.disconnect();
    sub.disconnect();
    console.warn(`[SOCKET] Sin adaptador Redis (${e.message}): difusión local en esta instancia.`);
  }
}

export function initSocket(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: { origin: origenesPermitidos(), methods: ['GET', 'POST'] },
    // Recupera los eventos perdidos durante cortes breves de red (≤ 2 min) sin recargar
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
  });
  void adaptadorRedis(io);

  io.use(async (socket, next) => {
    const user = await verificarTokenSocket(socket.handshake.auth?.token);
    if (!user) return next(new Error('no_autorizado'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    socket.join([`usuario:${u.id}`, `rol:${u.rol}`]);
    setWebSocketConnections(io!.engine.clientsCount);
    socket.on('disconnect', () => setWebSocketConnections(io?.engine.clientsCount ?? 0));
  });

  alInvalidarCuenta(id => {
    if (!io) return;
    if (id === undefined) io.disconnectSockets(true);
    else io.in(`usuario:${id}`).disconnectSockets(true);
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
  if (io && roles.length) io.to(roles.map(r => `rol:${r}`)).emit(channel, data);
}

/** Envía a las sesiones de los usuarios indicados (todas sus pestañas y equipos). */
export function emitirAUsuarios(usuarios: number[], channel: string, data: any) {
  if (io && usuarios.length) io.to(usuarios.map(id => `usuario:${id}`)).emit(channel, data);
}
