/**
 * Integración HTTP del módulo de cámaras, monitoreo y medios sobre la aplicación real
 * (crearApp), con una base de datos simulada en memoria y sin red (MediaMTX, motor ANPR y
 * diagnóstico RTSP/ICMP son dobles). Comprueba el contrato que consumen el frontend y
 * MediaMTX: rutas, permisos, códigos de estado y formato de las respuestas, y que la
 * contraseña RTSP nunca sale de la API aunque el formulario la devuelva enmascarada.
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';

process.env.ANPR_SERVICE_TOKEN = 'token-de-prueba';

const CLAVE = 'S3cr$&t';
const URL_GUARDADA = `rtsp://admin:${CLAVE}@192.168.1.64:554/Streaming/Channels/101`;
const URL_ENMASCARADA = 'rtsp://admin:******@192.168.1.64:554/Streaming/Channels/101';

/** Estado de la base simulada: tabla Camaras y consultas recibidas (texto y parámetros). */
const mockBase = {
  camaras: new Map<number, Record<string, any>>(),
  consultas: [] as { texto: string; entradas: Record<string, any> }[],
  siguienteId: 10,
  /** Consultas que fallan (simula una caída de la base) */
  falla: null as RegExp | null,
};

jest.mock('../../infraestructura/db', () => {
  const codigos: Record<number, string> = { 1: 'ADMIN', 3: 'GUARDIA', 4: 'GESTOR_PERMISOS' };
  const resultado = (recordset: unknown[] = []) => ({ recordset, recordsets: [recordset], rowsAffected: [recordset.length] });
  const peticion = () => {
    const entradas: Record<string, any> = {};
    const r: any = {
      input: (nombre: string, a: unknown, b?: unknown) => { entradas[nombre] = b === undefined ? a : b; return r; },
      batch: async () => resultado(),
      query: async (texto: string) => {
        mockBase.consultas.push({ texto, entradas: { ...entradas } });
        if (mockBase.falla?.test(texto)) throw new Error('conexión perdida');
        const id = Number(entradas.id);
        const c = mockBase.camaras.get(id);
        if (/FROM Usuarios u JOIN Roles r ON r\.id = u\.rol_id WHERE u\.id = @id/.test(texto)) {
          return resultado(codigos[id] ? [{ estado: 'activo', bloqueado: 0, bloqueado_hasta: null, codigo: codigos[id] }] : []);
        }
        if (/FROM Camaras c WHERE c\.id = @id/.test(texto)) return resultado(c ? [c] : []);
        if (/FROM Camaras c ORDER BY c\.nombre/.test(texto)) return resultado([...mockBase.camaras.values()]);
        if (/SELECT id, nombre, ip, rtsp_url, activa FROM Camaras WHERE id = @id/.test(texto)) return resultado(c ? [c] : []);
        if (/SELECT id, nombre, rtsp_url, ip FROM Camaras WHERE activa = 1/.test(texto)) {
          return resultado([...mockBase.camaras.values()].filter(x => x.activa));
        }
        if (/SELECT id FROM Camaras WHERE id = @id AND activa = 1/.test(texto)) return resultado(c?.activa ? [{ id }] : []);
        if (/INSERT INTO Camaras \(/.test(texto)) {
          const nuevo = mockBase.siguienteId++;
          mockBase.camaras.set(nuevo, {
            id: nuevo, nombre: entradas.nombre, ip: entradas.ip, rtsp_url: entradas.rtsp, ubicacion: entradas.ubicacion,
            activa: true, estado: 'SIN_VERIFICAR', ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null,
            created_at: '2026-10-04T10:00:00.000Z', roi: null, detecciones: 0,
          });
          return resultado([{ id: nuevo }]);
        }
        if (/UPDATE Camaras SET nombre = @nombre/.test(texto)) {
          if (c) Object.assign(c, { nombre: entradas.nombre, ip: entradas.ip, rtsp_url: entradas.rtsp, ubicacion: entradas.ubicacion });
          return resultado();
        }
        if (/UPDATE Camaras SET activa = CASE/.test(texto)) {
          if (!c) return resultado();
          c.activa = !c.activa;
          return resultado([{ nombre: c.nombre, activa: c.activa }]);
        }
        if (/UPDATE Camaras SET roi = @roi/.test(texto)) {
          if (!c) return resultado();
          c.roi = entradas.roi;
          return resultado([{ nombre: c.nombre }]);
        }
        if (/DELETE FROM Camaras WHERE id = @id/.test(texto)) {
          mockBase.camaras.delete(id);
          return resultado();
        }
        return resultado();
      },
    };
    return r;
  };
  return { getDB: () => ({ request: peticion }) };
});
jest.mock('../../infraestructura/servicios/socket', () => ({ emitEvent: jest.fn(), emitirAUsuarios: jest.fn(), emitirARoles: jest.fn() }));
// Solo se reemplaza lo que sale a la red; destinoRtsp, los tickets y las rutas son los reales
jest.mock('../../infraestructura/servicios/conectividadCamaras', () => {
  const rtsp = { host: '192.168.1.64', puerto: 554, en_linea: true, diagnostico: 'ok', tiempo_ms: 9, mensaje: 'Flujo de video disponible' };
  return {
    ...jest.requireActual('../../infraestructura/servicios/conectividadCamaras'),
    probarConexion: jest.fn().mockResolvedValue(rtsp),
    diagnosticar: jest.fn().mockResolvedValue({ ping: null, rtsp }),
    registrarConexion: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock('../../infraestructura/servicios/medios', () => ({
  ...jest.requireActual('../../infraestructura/servicios/medios'),
  sincronizarRutas: jest.fn().mockResolvedValue(undefined),
  crearRutaPrueba: jest.fn().mockResolvedValue('prueba_0123456789ab'),
  eliminarRutaPrueba: jest.fn().mockResolvedValue(undefined),
  estadoRuta: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../infraestructura/servicios/servicioAnpr', () => ({
  ...jest.requireActual('../../infraestructura/servicios/servicioAnpr'),
  estadoServicioAnpr: jest.fn().mockResolvedValue({ en_linea: false, error: 'Servicio no disponible' }),
  cambiarCamaraAnpr: jest.fn().mockResolvedValue({}),
  fijarRoiAnpr: jest.fn().mockResolvedValue({}),
  roiActivaAnpr: jest.fn().mockResolvedValue(undefined),
  fuenteActivaAnpr: jest.fn().mockResolvedValue(null),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { crearApp } = require('../../app') as { crearApp: () => Express };
const conectividad = jest.requireMock('../../infraestructura/servicios/conectividadCamaras') as Record<string, jest.Mock>;
const medios = jest.requireMock('../../infraestructura/servicios/medios') as Record<string, jest.Mock>;
const anpr = jest.requireMock('../../infraestructura/servicios/servicioAnpr') as Record<string, jest.Mock>;

const ROLES = { Admin: 1, Guardia: 3, GestorPermisos: 4 } as const;
type Rol = keyof typeof ROLES;
const como = (rol: Rol) => ({
  Authorization: `Bearer ${jwt.sign({ id: ROLES[rol], email: `${rol}@ecu911.gob.ec`, username: rol, nombre: rol, rol }, process.env.JWT_SECRET!)}`,
});

const consultas = (patron: RegExp) => mockBase.consultas.filter(q => patron.test(q.texto));

function reiniciar() {
  mockBase.camaras.clear();
  mockBase.camaras.set(3, {
    id: 3, nombre: 'Garita norte', ip: '192.168.1.64', rtsp_url: URL_GUARDADA, ubicacion: 'Acceso vehicular norte', activa: true,
    estado: 'EN_LINEA', ultimo_ping: null, tiempo_respuesta_ms: 9, mensaje_ping: 'Flujo de video disponible',
    created_at: '2026-10-01T08:00:00.000Z', roi: null, detecciones: 0,
  });
  // Deshabilitada y con historial
  mockBase.camaras.set(5, {
    id: 5, nombre: 'Garita sur', ip: '192.168.1.70', rtsp_url: 'rtsp://192.168.1.70/live', ubicacion: 'Acceso sur', activa: false,
    estado: 'SIN_CONEXION', ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null,
    created_at: '2026-09-01T08:00:00.000Z', roi: null, detecciones: 12,
  });
  mockBase.consultas.length = 0;
  mockBase.falla = null;
}

describe('API · cámaras, monitoreo y medios', () => {
  let app: Express;
  let silencio: jest.SpyInstance;
  beforeAll(() => { app = crearApp(); });
  beforeEach(() => {
    reiniciar();
    jest.clearAllMocks();
    silencio = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => silencio.mockRestore());

  describe('cámaras', () => {
    it('GET /:id: mismo formato que el listado y sin la contraseña; 404, 400, 403 y 401', async () => {
      const lista = await request(app).get('/api/camaras').set(como('Guardia')).expect(200);
      const detalle = await request(app).get('/api/camaras/3').set(como('Guardia')).expect(200);
      expect(detalle.body).toEqual(lista.body.find((c: { id: number }) => c.id === 3));
      expect(detalle.body).toMatchObject({
        id: 3, rtsp_url: URL_ENMASCARADA, tiene_credenciales: true, activa: true, estado: 'EN_LINEA', detecciones: 0, roi: null,
      });
      expect(JSON.stringify(lista.body)).not.toContain(CLAVE);
      await request(app).get('/api/camaras/99').set(como('Guardia')).expect(404, { error: 'Cámara no encontrada.' });
      await request(app).get('/api/camaras/0').set(como('Guardia')).expect(400, { error: 'Identificador inválido.' });
      await request(app).get('/api/camaras/3').set(como('GestorPermisos')).expect(403);
      await request(app).get('/api/camaras/3').expect(401);
    });

    // Permiso de cada ruta: camaras:gestionar solo el Admin; operacion:monitorear también el Guardia
    it.each([
      ['post', '/api/camaras/probar', 'Guardia'],
      ['post', '/api/camaras/prueba-video', 'Guardia'],
      ['delete', '/api/camaras/prueba-video/prueba_0123456789ab', 'Guardia'],
      ['put', '/api/camaras/3', 'Guardia'],
      ['patch', '/api/camaras/3/toggle', 'Guardia'],
      ['delete', '/api/camaras/3', 'Guardia'],
      ['post', '/api/camaras/3/video', 'GestorPermisos'],
      ['get', '/api/camaras/video/cam_3/estado', 'GestorPermisos'],
    ] as const)('%s %s → 403 para %s, sin efectos', async (metodo, ruta, rol) => {
      await request(app)[metodo](ruta).set(como(rol)).send({}).expect(403);
      expect(consultas(/\b(INSERT|UPDATE|DELETE)\b/i)).toHaveLength(0);
      for (const f of [medios.crearRutaPrueba, medios.eliminarRutaPrueba, medios.estadoRuta, conectividad.diagnosticar, conectividad.probarConexion]) {
        expect(f).not.toHaveBeenCalled();
      }
    });

    it('POST /: datos inválidos → 400 con el motivo y sin escribir; válidos → 201 { message, camera }', async () => {
      const invalida = await request(app).post('/api/camaras').set(como('Admin'))
        .send({ nombre: 'Garita <b>', ubicacion: 'Acceso', rtsp_url: 'rtsp://10.0.0.5/live' }).expect(400);
      expect(invalida.body).toEqual({ error: 'Nombre: letras, números, espacios y . , / # ( ) -.' });
      await request(app).post('/api/camaras').set(como('Admin'))
        .send({ nombre: 'Garita este', ubicacion: 'Acceso este', rtsp_url: 'rtsp://10.0.0.5/live', ip: '10.0.0.500' })
        .expect(400, { error: 'IP o host inválido.' });
      expect(consultas(/INSERT INTO (Camaras|AuditoriaOperaciones)/)).toEqual([]);

      const r = await request(app).post('/api/camaras').set(como('Admin'))
        .send({ nombre: 'Garita este', ubicacion: 'Acceso este', rtsp_url: 'rtsp://operador:clave2@10.0.0.5/live' }).expect(201);
      expect(r.body).toEqual({
        message: 'Cámara registrada.',
        camera: expect.objectContaining({
          id: 10, nombre: 'Garita este', ip: '10.0.0.5', rtsp_url: 'rtsp://operador:******@10.0.0.5/live', tiene_credenciales: true,
          activa: true, estado: 'SIN_VERIFICAR',
        }),
      });
      expect(consultas(/INSERT INTO AuditoriaOperaciones/)[0].entradas).toMatchObject({
        uid: 1, accion: 'CAMARA_ALTA', entidad: 'camara', eid: 10, detalle: 'Garita este · Acceso este',
      });
      await request(app).post('/api/camaras').set(como('Guardia')).send({}).expect(403);
    });

    it('PUT /:id con la URL enmascarada: guarda la contraseña real y responde enmascarada', async () => {
      const r = await request(app).put('/api/camaras/3').set(como('Admin'))
        .send({ nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', rtsp_url: URL_ENMASCARADA, ip: '' }).expect(200);
      expect(r.body.message).toBe('Cámara actualizada.');
      expect(r.body.camera.rtsp_url).toBe(URL_ENMASCARADA);
      expect(consultas(/UPDATE Camaras SET nombre = @nombre/)[0].entradas.rtsp).toBe(URL_GUARDADA);
      expect(consultas(/INSERT INTO AuditoriaOperaciones/)[0].entradas)
        .toMatchObject({ accion: 'CAMARA_EDICION', eid: 3, detalle: 'Garita norte: sin cambios' });
      // 404 antes de validar
      await request(app).put('/api/camaras/99').set(como('Admin')).send({}).expect(404, { error: 'Cámara no encontrada.' });
    });

    it('región de interés, habilitación y eliminación', async () => {
      await request(app).put('/api/camaras/3/roi').set(como('Admin')).send({ roi: [[0, 0], [1, 1]] })
        .expect(400, { error: 'La región de interés debe tener entre 3 y 12 vértices.' });
      const roi = await request(app).put('/api/camaras/3/roi').set(como('Admin')).send({ roi: [[0.1, 0.3], [0.9, 0.3], [0.5, 0.95]] }).expect(200);
      expect(roi.body).toMatchObject({ message: 'Región de interés guardada.', camera: { roi: [[0.1, 0.3], [0.9, 0.3], [0.5, 0.95]] } });
      const sinRoi = await request(app).put('/api/camaras/3/roi').set(como('Admin')).send({ roi: null }).expect(200);
      expect(sinRoi.body).toMatchObject({ message: 'Región de interés eliminada: se analiza el cuadro completo.', camera: { roi: null } });
      await request(app).put('/api/camaras/3/roi').set(como('Guardia')).send({ roi: null }).expect(403);

      const conHistorial = await request(app).delete('/api/camaras/5').set(como('Admin')).expect(409);
      expect(conHistorial.body.error).toBe('La cámara tiene 12 detecciones registradas: deshabilítela en lugar de eliminarla para conservar el historial.');
      const t = await request(app).patch('/api/camaras/5/toggle').set(como('Admin')).expect(200);
      expect(t.body).toMatchObject({ message: 'Cámara habilitada.', camera: { id: 5, activa: true } });
      await request(app).delete('/api/camaras/3').set(como('Admin')).expect(200, { message: 'Cámara eliminada.' });
      await request(app).patch('/api/camaras/3/toggle').set(como('Admin')).expect(404, { error: 'Cámara no encontrada.' });
    });

    it('diagnóstico: Ping del formulario con la contraseña guardada, ping de una cámara y de todas', async () => {
      const r = await request(app).post('/api/camaras/probar').set(como('Admin')).send({ rtsp_url: URL_ENMASCARADA, camara_id: 3 }).expect(200);
      expect(r.body.rtsp).toMatchObject({ en_linea: true, diagnostico: 'ok' });
      expect(conectividad.diagnosticar).toHaveBeenCalledWith(URL_GUARDADA, null);
      await request(app).post('/api/camaras/probar').set(como('Admin')).send({ rtsp_url: 'rtsp://10.0.0.5/live', ip: '10.0.0.300' })
        .expect(400, { error: 'IP o host inválido.' });

      await request(app).post('/api/camaras/3/ping').set(como('Admin')).expect(200);
      expect(conectividad.registrarConexion).toHaveBeenCalledWith(3, expect.objectContaining({ en_linea: true }), true);
      const todas = await request(app).post('/api/camaras/ping-all').set(como('Admin')).expect(200);
      expect(todas.body).toMatchObject({ total: 1, en_linea: 1, detalles: [{ id: 3, nombre: 'Garita norte' }] });
      await request(app).post('/api/camaras/ping-all').set(como('Guardia')).expect(403);
    });

    it('video: 409 deshabilitada; ruta y ticket; un fallo del servidor de video → 502', async () => {
      await request(app).post('/api/camaras/5/video').set(como('Guardia')).expect(409, { error: 'Habilite la cámara para reproducir su video.' });
      const v = await request(app).post('/api/camaras/3/video').set(como('Guardia')).expect(200);
      expect(v.body).toEqual({ ruta: 'cam_3', ticket: expect.any(String), webrtc: expect.any(String) });
      medios.sincronizarRutas.mockRejectedValueOnce(new Error('MediaMTX caído'));
      await request(app).post('/api/camaras/3/video').set(como('Guardia')).expect(502, { error: 'El servidor de video no respondió.' });
    });

    it('prueba de video y estado del flujo', async () => {
      const p = await request(app).post('/api/camaras/prueba-video').set(como('Admin')).send({ rtsp_url: URL_ENMASCARADA, camara_id: 3 }).expect(200);
      expect(p.body).toEqual({ ruta: 'prueba_0123456789ab', ticket: expect.any(String), webrtc: expect.any(String) });
      expect(medios.crearRutaPrueba).toHaveBeenCalledWith(URL_GUARDADA);
      await request(app).post('/api/camaras/prueba-video').set(como('Admin')).send({ rtsp_url: 'http://10.0.0.5' }).expect(400, { error: 'URL RTSP inválida.' });
      await request(app).get('/api/camaras/video/cam_3/estado').set(como('Guardia')).expect(200, { lista: false, lectores: 0, pistas: [] });
      await request(app).get('/api/camaras/video/otra/estado').set(como('Guardia')).expect(400, { error: 'Ruta inválida.' });
      await request(app).delete('/api/camaras/prueba-video/cam_3').set(como('Admin')).expect(200, { ok: true });
      expect(medios.eliminarRutaPrueba).not.toHaveBeenCalled();
      await request(app).delete('/api/camaras/prueba-video/prueba_0123456789ab').set(como('Admin')).expect(200, { ok: true });
      expect(medios.eliminarRutaPrueba).toHaveBeenCalledWith('prueba_0123456789ab');
    });
  });

  describe('monitoreo', () => {
    it('estado del motor y ticket de video (webcam solo para el administrador; alcance acotado)', async () => {
      await request(app).get('/api/monitoreo/estado').set(como('Guardia')).expect(200, { en_linea: false, error: 'Servicio no disponible' });
      await request(app).get('/api/monitoreo/estado').set(como('GestorPermisos')).expect(403);
      const t = await request(app).post('/api/monitoreo/ticket').set(como('Guardia')).send({}).expect(200);
      expect(Object.keys(t.body).sort()).toEqual(['ticket', 'url', 'webrtc']);
      await request(app).post('/api/monitoreo/ticket').set(como('Guardia')).send({ alcance: 'webcam' })
        .expect(403, { error: 'Solo el administrador puede usar la webcam como fuente de prueba.' });
      await request(app).post('/api/monitoreo/ticket').set(como('Admin')).send({ alcance: 'webcam' }).expect(200);
      await request(app).post('/api/monitoreo/ticket').set(como('Admin')).send({ alcance: 'pantalla' })
        .expect(400, { error: 'Alcance inválido. Valores: stream, webcam.' });
    });

    it('cambiar la cámara del motor: 400, 409, 200, 502 si el motor no responde y 403 sin camaras:operar', async () => {
      await request(app).post('/api/monitoreo/camara-activa').set(como('Admin')).send({ camara_id: 'abc' }).expect(400, { error: 'Seleccione una cámara.' });
      await request(app).post('/api/monitoreo/camara-activa').set(como('Admin')).send({ camara_id: 5 }).expect(409, { error: 'La cámara está deshabilitada.' });
      await request(app).post('/api/monitoreo/camara-activa').set(como('Admin')).send({ camara_id: 3 })
        .expect(200, { message: 'El motor ANPR ahora procesa Garita norte.' });
      expect(anpr.cambiarCamaraAnpr).toHaveBeenCalledWith(expect.objectContaining({ id: 3, rtsp_url: expect.stringMatching(/\/cam_3$/) }), true);
      anpr.cambiarCamaraAnpr.mockRejectedValueOnce(new Error('HTTP 503'));
      await request(app).post('/api/monitoreo/camara-activa').set(como('Admin')).send({ camara_id: 3 })
        .expect(502, { error: 'El servicio ANPR no respondió al cambio de cámara.' });
      await request(app).post('/api/monitoreo/camara-activa').set(como('Guardia')).send({ camara_id: 3 }).expect(403);
    });
  });

  describe('autorización de MediaMTX', () => {
    it('acepta el ticket emitido por la API y el token del motor; deniega lo demás con 401 sin cuerpo', async () => {
      const { body } = await request(app).post('/api/monitoreo/ticket').set(como('Guardia')).send({ alcance: 'stream' }).expect(200);
      const navegador = { action: 'read', path: 'cam_3', protocol: 'webrtc', query: `ticket=${body.ticket}` };
      const motor = { action: 'read', path: 'cam_3', protocol: 'rtsp', user: 'anpr', password: 'token-de-prueba' };
      expect((await request(app).post('/api/medios/autorizar').send(navegador).expect(200)).text).toBe('');
      await request(app).post('/api/medios/autorizar').send(motor).expect(200);
      expect((await request(app).post('/api/medios/autorizar').send({ ...navegador, path: 'cam_5' }).expect(401)).text).toBe('');
      await request(app).post('/api/medios/autorizar').send({ ...navegador, query: 'ticket=falso.firma' }).expect(401);
      await request(app).post('/api/medios/autorizar').send({ ...motor, action: 'publish' }).expect(401);
      await request(app).post('/api/medios/autorizar').send({ ...motor, password: 'otra' }).expect(401);
      await request(app).post('/api/medios/autorizar').send({ ...motor, path: 3 }).expect(401);
      // Ante una falla (p. ej. la base no responde) se deniega
      mockBase.falla = /SELECT id FROM Camaras/;
      await request(app).post('/api/medios/autorizar').send(motor).expect(401);
    });
  });
});
