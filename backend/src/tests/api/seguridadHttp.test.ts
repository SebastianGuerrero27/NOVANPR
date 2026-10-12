/**
 * Protección HTTP de la API: cabeceras de seguridad, límites de solicitudes y disponibilidad real
 * (/health/ready), sobre la aplicación completa con la base simulada.
 */
import express from 'express';
import request from 'supertest';
import { accesoAceptado, confianzaProxy, limitadorAcceso, RUTAS_ACCESO } from '../../interfaz/http/middlewares/seguridad';
import { ipDe } from '../../interfaz/http/peticion';

let mockBaseDisponible = true;
jest.mock('../../infraestructura/db', () => ({
  getDB: () => ({
    request: () => {
      const r: any = { input: () => r, query: async () => ({ recordset: [], rowsAffected: [0] }) };
      return r;
    },
  }),
  comprobarBaseDatos: async () => (mockBaseDisponible ? { ok: true, ms: 1 } : { ok: false, ms: null }),
}));
jest.mock('../../infraestructura/servicios/emailService', () => ({ emailService: { cuentaBloqueada: jest.fn(), smtpConfigurado: () => false } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { crearApp } = require('../../app');

describe('Protección HTTP de la API', () => {
  const entorno = { ...process.env };
  beforeAll(() => {
    process.env.LIMITE_SOLICITUDES = 'true';
    process.env.LIMITE_ACCESO_POR_15_MIN = '3';
    process.env.LIMITE_API_POR_MINUTO = '5';
    process.env.ANPR_SERVICE_TOKEN = 'token-de-servicio-de-prueba';
  });
  afterAll(() => {
    process.env = entorno;
  });

  it('cabeceras de seguridad y sin X-Powered-By', async () => {
    const r = await request(crearApp()).get('/health').expect(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
    // Evidencia visible desde el frontend en otro puerto (mismo sitio); sin forzar HTTPS en la red local
    expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(r.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('/health/ready: 200 con la base disponible; 503 si no responde', async () => {
    mockBaseDisponible = true;
    const ok = await request(crearApp()).get('/health/ready').expect(200);
    expect(ok.body).toMatchObject({ status: 'OK', base_datos: { ok: true }, redis: 'desactivado' });
    mockBaseDisponible = false;
    const caida = await request(crearApp()).get('/health/ready').expect(503);
    expect(caida.body).toMatchObject({ status: 'NO_DISPONIBLE', base_datos: { ok: false } });
    mockBaseDisponible = true;
  });

  it('acceso: al superar los intentos por IP responde 429 (frena el relleno de credenciales entre cuentas)', async () => {
    const app = crearApp();
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/api/auth/login').send({ email: `persona${i}@ecu911.gob.ec`, password: 'Incorrecta#1' });
      expect(r.status).not.toBe(429);
    }
    const bloqueada = await request(app).post('/api/auth/login').send({ email: 'otra@ecu911.gob.ec', password: 'Incorrecta#1' }).expect(429);
    expect(bloqueada.body).toEqual({ error: 'Demasiados intentos de acceso desde este equipo. Espere unos minutos e intente de nuevo.' });
    expect(bloqueada.headers['ratelimit-policy'] ?? bloqueada.headers.ratelimit).toBeDefined();
  });

  it('acceso: un inicio de sesión aceptado no cuenta; los fallidos y las demás rutas de acceso sí', () => {
    expect(accesoAceptado('/api/auth/login', 200)).toBe(true);
    expect(accesoAceptado('/api/auth/login?x=1', 200)).toBe(true);
    expect(accesoAceptado('/api/auth/login', 401)).toBe(false);
    expect(accesoAceptado('/api/auth/login', 423)).toBe(false);
    expect(accesoAceptado('/api/auth/olvide-password', 200)).toBe(false);
    expect(accesoAceptado('/api/auth/registro', 201)).toBe(false);
  });

  it('los ingresos aceptados no consumen el cupo del limitador de acceso (operadores tras una misma IP)', async () => {
    const a = express();
    a.use(express.json());
    a.use(RUTAS_ACCESO, limitadorAcceso());
    a.post('/api/auth/login', (req, res) => { res.status(req.body.ok ? 200 : 401).json({}); });
    for (let i = 0; i < 6; i++) await request(a).post('/api/auth/login').send({ ok: true }).expect(200);
    for (let i = 0; i < 3; i++) await request(a).post('/api/auth/login').send({ ok: false }).expect(401);
    await request(a).post('/api/auth/login').send({ ok: true }).expect(429);
  });

  it('recuperación de contraseña: responde 200 genérico, pero cuenta para el límite de acceso', async () => {
    const app = crearApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/olvide-password').send({ email: `persona${i}@ecu911.gob.ec` }).expect(200);
    }
    await request(app).post('/api/auth/olvide-password').send({ email: 'otra@ecu911.gob.ec' }).expect(429);
  });

  it('IP de auditoría: X-Forwarded-For solo vale detrás de un proxy de confianza (TRUST_PROXY)', async () => {
    const appCon = (trust: string | undefined) => {
      const a = express();
      a.set('trust proxy', confianzaProxy(trust));
      a.get('/ip', (req, res) => { res.json({ ip: ipDe(req) }); });
      return a;
    };
    const directa = await request(appCon(undefined)).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(directa.body.ip).not.toContain('203.0.113.7');
    const trasProxy = await request(appCon('1')).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(trasProxy.body.ip).toBe('203.0.113.7');
  });

  it('límite general por IP; no aplica al motor (token de servicio) ni a la autorización de MediaMTX', async () => {
    const app = crearApp();
    for (let i = 0; i < 5; i++) await request(app).get('/api/camaras');
    await request(app).get('/api/camaras').expect(429);

    const otra = crearApp();
    for (let i = 0; i < 8; i++) {
      const r = await request(otra).get('/api/camaras').set('X-Servicio-Token', 'token-de-servicio-de-prueba');
      expect(r.status).not.toBe(429);
      const m = await request(otra).post('/api/medios/autorizar').send({ action: 'read', path: 'cam_1', protocol: 'webrtc', query: '' });
      expect(m.status).not.toBe(429);
    }
  });
});
