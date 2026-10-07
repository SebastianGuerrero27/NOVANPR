#!/usr/bin/env node
/**
 * Benchmark reproducible del canal de notificaciones (evidencia experimental del artículo).
 *
 * Simula N pasos de vehículos SIN permiso tal como los envía el motor ANPR (fase 1 /ingreso +
 * fase 2 /completar-ocr) y mide, para cada uno, el tiempo hasta que la notificación
 * `acceso.no_registrado` llega por Socket.IO a una sesión con el permiso avisos:acceso:
 *
 *   t0 = envío de /completar-ocr (la lectura OCR está lista)
 *   t1 = recepción de notificacion:nueva en el cliente (WebSocket)
 *   latencia = t1 − t0   → incluye cruce de listas, política de decisión, escritura en la base,
 *                          fan-out por permiso y entrega en tiempo real.
 *
 * Uso:
 *   node scripts/benchmark_notificaciones.js --api http://localhost:5000 --servicio <ANPR_SERVICE_TOKEN> \
 *        --email gestor@ecu911.gob.ec --password '...' [--muestras 100] [--pausa-ms 250] [--csv salida.csv]
 *
 * Las placas usan el prefijo BMK y los pasos la fuente "benchmark": se eliminan desde
 * Registro de ingresos filtrando por placa BMK (permiso detecciones:eliminar).
 */
const { io } = require('socket.io-client');
const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, l) => (v.startsWith('--') ? [...a, [v.slice(2), l[i + 1]]] : a), []));
const API = (args.api || 'http://localhost:5000').replace(/\/$/, '');
const N = Number(args.muestras || 100);
const PAUSA = Number(args['pausa-ms'] || 250);
if (!args.servicio || !args.email || !args.password) {
  console.error('Faltan --servicio, --email o --password. Vea el encabezado del script.');
  process.exit(2);
}

const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const post = (ruta, cuerpo, cabeceras = {}) => fetch(`${API}${ruta}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo),
}).then(json);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const percentil = (xs, p) => { const s = [...xs].sort((a, b) => a - b); const k = (s.length - 1) * p; const i = Math.floor(k); return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (k - i); };

(async () => {
  const sesion = await post('/api/auth/login', { email: args.email, password: args.password });
  if (!sesion.token) throw new Error(`Inicio de sesión fallido: ${JSON.stringify(sesion)}`);
  if (!sesion.user.permisos.includes('avisos:acceso')) throw new Error('La cuenta no tiene el permiso avisos:acceso.');

  const pendientes = new Map(); // deteccion_id → resolver(t1)
  const socket = io(API, { auth: { token: sesion.token }, transports: ['websocket'] });
  socket.on('notificacion:nueva', (n) => {
    const id = n?.datos?.deteccion_id;
    if (n.tipo === 'acceso.no_registrado' && pendientes.has(id)) { pendientes.get(id)(performance.now()); pendientes.delete(id); }
  });
  await new Promise((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });

  const servicio = { 'X-Servicio-Token': args.servicio };
  const base = Date.now() % 100000;
  const muestras = [];
  const perdidas = [];
  for (let i = 0; i < N; i++) {
    const tid = 900000 + base + i;
    const placa = `BMK${String((base + i) % 10000).padStart(4, '0')}`;
    const ing = await post('/api/detecciones/ingreso', { tracking_id: tid, ruta_imagen_ingreso: `/media/benchmark_${tid}.jpg`, confianza_deteccion: 0.9, fuente: 'benchmark' }, servicio);
    const llegada = new Promise((res) => { pendientes.set(ing.ingreso_id, res); setTimeout(() => res(null), 10000); });
    const t0 = performance.now();
    await post('/api/detecciones/completar-ocr', { ingreso_id: ing.ingreso_id, placa_reconocida: placa, confianza_ocr: 0.95, lectura_valida: true }, servicio);
    const t1 = await llegada;
    if (t1 === null) perdidas.push(ing.ingreso_id); else muestras.push(t1 - t0);
    process.stdout.write(`\r${i + 1}/${N}`);
    await espera(PAUSA);
  }
  socket.disconnect();

  const media = muestras.reduce((a, b) => a + b, 0) / (muestras.length || 1);
  const resumen = {
    muestras: muestras.length, perdidas: perdidas.length, entrega: `${((muestras.length / N) * 100).toFixed(1)} %`,
    media_ms: +media.toFixed(1), p50_ms: +percentil(muestras, 0.5).toFixed(1), p95_ms: +percentil(muestras, 0.95).toFixed(1),
    p99_ms: +percentil(muestras, 0.99).toFixed(1), max_ms: +Math.max(...muestras).toFixed(1),
  };
  console.log('\n', JSON.stringify(resumen, null, 2));
  if (args.csv) fs.writeFileSync(args.csv, ['muestra,latencia_ms', ...muestras.map((m, i) => `${i + 1},${m.toFixed(2)}`)].join('\n'));
  process.exit(perdidas.length ? 1 : 0);
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
