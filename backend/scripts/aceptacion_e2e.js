#!/usr/bin/env node
/**
 * Prueba de aceptación de extremo a extremo: rol Gestor de accesos, permisos de placa con horario,
 * política de decisión R1–R7, centro de notificaciones (Socket.IO, ACK, escalamiento, Web Push),
 * solicitudes de acceso con separación de funciones y métricas.
 *
 * Requisitos: base de datos VACÍA (sin administrador), backend en modo desarrollo SIN SMTP (los
 * enlaces para definir contraseña se escriben en su salida estándar, que este script lee) y
 * NOTIF_ESCALAMIENTO_SEGUNDOS=20 para comprobar el escalamiento en menos de un minuto.
 *
 *   node scripts/aceptacion_e2e.js --api http://localhost:5000 --servicio <ANPR_SERVICE_TOKEN> --log backend.log
 */
const { io } = require('socket.io-client');
const fs = require('fs');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, l) => (v.startsWith('--') ? [...a, [v.slice(2), l[i + 1]]] : a), []));
const RAIZ = (args.api || 'http://localhost:5000').replace(/\/$/, '');
const B = `${RAIZ}/api`;
const LOG = args.log;
if (!args.servicio || !LOG) { console.error('Faltan --servicio o --log.'); process.exit(2); }

/** Cliente mínimo con la forma { status, data } (fetch nativo de Node 18+). */
async function pedir(metodo, url, cuerpo, opciones = {}) {
  const r = await fetch(url, { method: metodo, headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await r.text();
  let data; try { data = JSON.parse(texto); } catch { data = texto; }
  return { status: r.status, data };
}
const axios = {
  get: (url, o) => pedir('GET', url, undefined, o),
  post: (url, c, o) => pedir('POST', url, c ?? {}, o),
};
const SRV = { headers: { 'X-Servicio-Token': args.servicio } };
const h = t => ({ headers: t ? { Authorization: `Bearer ${t}` } : {} });
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) process.exitCode = 1; };
const espera = ms => new Promise(r => setTimeout(r, ms));
const PASS = 'ClaveSegura#2026';

async function tokenRestablecer(email) {
  for (let i = 0; i < 20; i++) {
    const txt = fs.readFileSync(LOG, 'utf8');
    const re = new RegExp(`Para: ${email.replace('.', '\\.')}[\\s\\S]*?restablecer-password\\?token=([a-f0-9]{64})`, 'g');
    let m, ultimo = null; while ((m = re.exec(txt))) ultimo = m[1];
    if (ultimo) return ultimo;
    await espera(300);
  }
  throw new Error('sin token para ' + email);
}

async function crearUsuario(admin, email, nombre, rol) {
  const r = await axios.post(`${B}/usuarios`, { email, nombre_completo: nombre, rol }, h(admin));
  if (r.status !== 201) throw new Error(`crear ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  const token = await tokenRestablecer(email);
  const p = await axios.post(`${B}/auth/restablecer-password`, { token, password: PASS }, h());
  if (p.status !== 200) throw new Error(`password ${email}: ${p.status} ${JSON.stringify(p.data)}`);
  const l = await axios.post(`${B}/auth/login`, { email, password: PASS });
  return l.data;
}

async function paso(placa, tid, extra = {}) {
  const i = await axios.post(`${B}/detecciones/ingreso`, { tracking_id: tid, ruta_imagen_ingreso: `/media/ingreso_${tid}.jpg`, confianza_deteccion: 0.93, fuente: 'e2e' }, SRV);
  const t0 = Date.now();
  const c = await axios.post(`${B}/detecciones/completar-ocr`, { ingreso_id: i.data.ingreso_id, placa_reconocida: placa, confianza_ocr: 0.96, lectura_valida: true, ...extra }, SRV);
  return { id: i.data.ingreso_id, det: c.data.deteccion, t0 };
}

(async () => {
  // 1. Configuración inicial + cuentas por rol
  let r = await axios.post(`${B}/auth/configuracion-inicial`, { email: 'admin@ecu911.gob.ec', nombre_completo: 'Administradora Zonal', password: PASS }, h());
  const admin = r.status === 201 ? r.data.token : (await axios.post(`${B}/auth/login`, { email: 'admin@ecu911.gob.ec', password: PASS })).data.token;
  ok(!!admin, 'administrador inicial');
  const gestor = await crearUsuario(admin, 'gestor@ecu911.gob.ec', 'Gabriela Gestora Permisos', 'GestorPermisos');
  const operador = await crearUsuario(admin, 'guardia@ecu911.gob.ec', 'Oscar Guardia Garita', 'Guardia');
  ok(gestor.user.rol === 'GestorPermisos' && gestor.user.permisos.includes('padron:gestionar') && !gestor.user.permisos.includes('operacion:monitorear'), 'login del Gestor de permisos (sin monitoreo)');
  ok(operador.user.permisos.includes('avisos:garita') && operador.user.permisos.includes('avisos:padron') && !operador.user.permisos.includes('padron:gestionar'), 'login del Guardia con sus permisos');

  // 2. Sockets de tiempo real (operador y gestor)
  const recibidas = { op: [], ge: [], adm: [] };
  const conectar = (t, k) => new Promise(res => { const s = io(RAIZ, { auth: { token: t }, transports: ['websocket'] }); s.on('notificacion:nueva', n => recibidas[k].push({ n, t: Date.now() })); s.on('connect', () => res(s)); });
  const [sOp, sGe, sAdm] = await Promise.all([conectar(operador.token, 'op'), conectar(gestor.token, 'ge'), conectar(admin, 'adm')]);
  ok(sOp.connected && sGe.connected, 'Socket.IO autenticado (salas usuario:{id})');

  // 3. RBAC: el operador no gestiona el padrón; el gestor no gestiona alertas
  r = await axios.post(`${B}/vehiculos-autorizados`, { placa: 'ZZZ0001', propietario: 'X' }, h(operador.token));
  ok(r.status === 403, `guardia no crea permisos (HTTP ${r.status})`);
  r = await axios.post(`${B}/blacklist`, { placa: 'ZZZ0002', motivo: 'Prueba de permisos', nivel_alerta: 'ALTA' }, h(gestor.token));
  ok(r.status === 403, `gestor no edita la lista negra (HTTP ${r.status})`);

  // 4. El gestor crea permisos: uno con horario que excluye ahora (domingo 03:00-03:01) y uno 24/7
  r = await axios.post(`${B}/vehiculos-autorizados`, { placa: 'ABC1234', propietario: 'Proveedor Nocturno', categoria: 'PROVEEDOR', horario: [{ dias: [7], desde: '03:00', hasta: '03:01' }] }, h(gestor.token));
  ok(r.status === 201 && r.data.item.horario_texto === 'D 03:00–03:01', `permiso con franja horaria (${r.data.item?.horario_texto})`);
  r = await axios.post(`${B}/vehiculos-autorizados`, { placa: 'XYZ9876', propietario: 'Funcionaria Permanente', categoria: 'FUNCIONARIO' }, h(gestor.token));
  ok(r.status === 201, 'permiso 24/7');
  await espera(800);
  // El guardia recibe "Se ha otorgado permiso a … con vehículo de placa …" con enlace a la lista blanca
  const otorgado = recibidas.op.find(x => x.n.tipo === 'padron.permiso_otorgado' && x.n.titulo.includes('XYZ9876'));
  ok(!!otorgado && /Se ha otorgado permiso a Funcionaria Permanente/.test(otorgado.n.mensaje) && otorgado.n.enlace === '/listas/autorizados?q=XYZ9876',
    `guardia notificado del permiso otorgado: ${otorgado?.n.mensaje} → ${otorgado?.n.enlace}`);
  ok(!recibidas.ge.some(x => x.n.tipo === 'padron.permiso_otorgado'), 'quien otorga el permiso no se lo notifica a sí mismo');
  r = await axios.post(`${B}/vehiculos-autorizados`, { placa: 'BAD0001', propietario: 'x', horario: [{ dias: [9], desde: '25:00', hasta: '1' }] }, h(gestor.token));
  ok(r.status === 400, `horario inválido rechazado (${r.data.error})`);

  // 5. Pasos vehiculares simulados por el motor ANPR
  const fuera = await paso('ABC1234', 9001);
  ok(fuera.det.estado_validacion === 'no_reconocido' && fuera.det.restriccion_acceso === 'fuera_horario', `R2 fuera de horario → ${fuera.det.estado_validacion}/${fuera.det.restriccion_acceso}`);
  ok(/horario autorizado: D 03:00–03:01/.test(fuera.det.motivo_revision || ''), `motivo explicado: ${fuera.det.motivo_revision}`);
  const vigente = await paso('XYZ9876', 9002);
  ok(vigente.det.estado_validacion === 'autorizado', `R5 permiso vigente → ${vigente.det.estado_validacion}`);
  const dudosa = await paso('XYZ9876'.replace('9876', '9877'), 9003, { lectura_valida: false });
  ok(dudosa.det.estado_validacion === 'pendiente_revision', `R6 sin permiso y lectura inválida → ${dudosa.det.estado_validacion}`);
  const sinPermiso = await paso('QWE1111', 9004);
  ok(sinPermiso.det.estado_validacion === 'no_reconocido' && !sinPermiso.det.restriccion_acceso, `R7 sin permiso → ${sinPermiso.det.estado_validacion}`);
  await espera(1500);

  // 6. Notificaciones: enrutamiento por permiso y latencia
  const tipos = k => recibidas[k].map(x => x.n.tipo);
  ok(!['acceso.restringido', 'acceso.no_registrado', 'acceso.confirmacion'].some(t => tipos('ge').includes(t)), `el gestor no recibe avisos de monitoreo: ${[...new Set(tipos('ge'))].join(', ')}`);
  const llegada = recibidas.ge.find(x => x.n.tipo === 'acceso.llegada_permiso' && x.n.titulo.includes('XYZ9876'));
  ok(!!llegada, `el gestor recibe la llegada del vehículo al que dio permiso: ${llegada?.n.mensaje}`);
  ok(!recibidas.op.some(x => x.n.tipo === 'acceso.llegada_permiso'), 'la llegada solo va a quien otorgó el permiso');
  ok(tipos('op').includes('acceso.confirmacion') && tipos('op').includes('acceso.restringido'), `guardia recibe: ${[...new Set(tipos('op'))].join(', ')}`);
  const nr = recibidas.op.find(x => x.n.tipo === 'acceso.no_registrado');
  ok(!!nr, `latencia completar-ocr → notificación en el socket: ${nr ? nr.t - sinPermiso.t0 : '?'} ms`);

  // 7. ACK desde el aviso de garita ("Enterado")
  r = await axios.post(`${B}/notificaciones/reconocer-deteccion/${sinPermiso.id}`, {}, h(operador.token));
  ok(r.status === 200 && r.data.reconocidas === 1, `ACK del guardia (${r.data.reconocidas} alarma)`);
  r = await axios.get(`${B}/notificaciones?filtro=pendientes`, h(admin));
  ok(!r.data.items.some(n => n.datos?.deteccion_id === sinPermiso.id), 'la alarma atendida deja de estar pendiente para el administrador');

  // 8. Solicitud de acceso con separación de funciones
  r = await axios.post(`${B}/solicitudes-acceso`, { placa: 'QWE1111', propietario: 'Proveedor de radios', motivo: 'Entrega de equipos de radio', categoria: 'PROVEEDOR', deteccion_id: sinPermiso.id, horario: [{ dias: [1, 2, 3, 4, 5, 6, 7], desde: '00:00', hasta: '23:59' }] }, h(operador.token));
  ok(r.status === 201, `guardia crea solicitud #${r.data.solicitud?.id}`);
  const sol = r.data.solicitud;
  r = await axios.post(`${B}/solicitudes-acceso`, { placa: 'QWE1111', propietario: 'x', motivo: 'duplicada' }, h(operador.token));
  ok(r.status === 409, 'una sola solicitud pendiente por placa');
  await espera(800);
  ok(tipos('ge').includes('solicitud.nueva') && !tipos('op').includes('solicitud.nueva'), 'el gestor recibe la solicitud; el solicitante no');
  r = await axios.post(`${B}/solicitudes-acceso/${sol.id}/aprobar`, {}, h(operador.token));
  ok(r.status === 403, `guardia no aprueba (HTTP ${r.status})`);
  r = await axios.post(`${B}/solicitudes-acceso`, { placa: 'GGG7777', propietario: 'Familiar', motivo: 'Visita propia' }, h(gestor.token));
  ok(r.status === 403, `el gestor no crea solicitudes: otorga el permiso directamente (HTTP ${r.status})`);
  r = await axios.post(`${B}/solicitudes-acceso`, { placa: 'GGG7777', propietario: 'Familiar', motivo: 'Visita propia del administrador' }, h(admin));
  const propia = r.data.solicitud;
  r = await axios.post(`${B}/solicitudes-acceso/${propia.id}/aprobar`, {}, h(admin));
  ok(r.status === 403 && /Separación de funciones/.test(r.data.error), `SoD: nadie aprueba su propia solicitud (${r.status})`);
  r = await axios.post(`${B}/solicitudes-acceso/${sol.id}/aprobar`, { comentario: 'Autorizado por una semana', ajustes: { fecha_fin: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) } }, h(gestor.token));
  ok(r.status === 200 && r.data.permiso?.placa === 'QWE1111', `gestor aprueba: ${r.data.message}`);
  r = await axios.post(`${B}/solicitudes-acceso/${sol.id}/aprobar`, {}, h(gestor.token));
  ok(r.status === 409, 'no se aprueba dos veces');
  await espera(800);
  ok(tipos('op').includes('solicitud.resuelta'), 'el guardia recibe la resolución');
  ok(recibidas.op.some(x => x.n.tipo === 'padron.permiso_otorgado' && x.n.titulo.includes('QWE1111')), 'la solicitud aprobada también se anuncia como permiso otorgado');
  r = await axios.post(`${B}/detecciones/validar/${sinPermiso.id}`, { placa_validada: 'QWE1111' }, h(operador.token));
  ok(r.data.deteccion?.estado_validacion === 'autorizado', `el ingreso que originó la solicitud queda ${r.data.deteccion?.estado_validacion}`);

  // 9. Excepción fuera de horario
  r = await axios.post(`${B}/detecciones/validar/${fuera.id}`, { placa_validada: 'ABC1234', excepcion: true, observacion: 'Entrega urgente' }, h(operador.token));
  ok(r.status === 403, 'guardia no autoriza excepciones');
  r = await axios.post(`${B}/detecciones/validar/${fuera.id}`, { placa_validada: 'ABC1234' }, h(operador.token));
  ok(r.data.deteccion?.estado_validacion === 'no_reconocido', 'validar sin excepción mantiene la restricción horaria');
  r = await axios.post(`${B}/detecciones/validar/${fuera.id}`, { placa_validada: 'ABC1234', excepcion: true, observacion: 'Entrega urgente autorizada' }, h(admin));
  ok(r.data.deteccion?.estado_validacion === 'autorizado', 'el administrador autoriza por excepción');
  r = await axios.get(`${B}/detecciones/${fuera.id}`, h(admin));
  ok(r.data.auditoria.some(a => a.accion === 'EXCEPCION_ACCESO'), 'la excepción queda en la auditoría');

  // 10. Escalamiento: alarma sin ACK > 20 s → administrador
  const ignorada = await paso('NOA0001', 9005);
  console.log('… esperando el escalamiento (umbral 20 s, barrido cada 15 s)');
  let escalada = null;
  for (let i = 0; i < 30 && !escalada; i++) { await espera(2000); escalada = recibidas.adm.find(x => x.n.tipo === 'alarma.escalada' && x.n.titulo.includes('NOA0001')); }
  ok(!!escalada, `alarma escalada al administrador: ${escalada?.n.titulo}`);
  ok(!recibidas.op.some(x => x.n.tipo === 'alarma.escalada'), 'el guardia no recibe la escalada');

  // 11. Push, métricas, panel del gestor
  r = await axios.post(`${B}/notificaciones/push/suscripcion`, { endpoint: 'https://push.ejemplo.invalid/abc', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }, h(gestor.token));
  ok(r.status === 201, 'suscripción Web Push registrada');
  r = await axios.get(`${B}/notificaciones/push/clave`, h(gestor.token));
  ok(r.data.habilitado && r.data.clave_publica?.length > 60, 'clave pública VAPID disponible');
  r = await axios.get(`${B}/panel/accesos`, h(gestor.token));
  ok(r.status === 200 && r.data.padron.vigentes >= 2, `panel del gestor: ${JSON.stringify({ solicitudes: r.data.solicitudes.pendientes, padron: r.data.padron, hoy: r.data.hoy })}`);
  r = await axios.get(`${B}/notificaciones/metricas?dias=1`, h(admin));
  ok(r.status === 200, `métricas de alarmas: ${JSON.stringify(r.data.por_severidad.map(f => ({ s: f.severidad, n: f.emitidas, ack: f.reconocidas, esc: f.escaladas, tta: f.tta_mediana_s })))}`);
  const prom = (await axios.get(`${RAIZ}/metrics`)).data;
  ok(/anpr_notificaciones_total\{tipo="acceso.restringido"/.test(prom) && /anpr_notificacion_latencia_seconds_bucket/.test(prom) && /anpr_notificacion_tiempo_reconocimiento_seconds_count/.test(prom), 'métricas Prometheus de notificaciones');
  const lat = prom.match(/anpr_notificacion_latencia_seconds_sum\{tipo="acceso.no_registrado"\} ([\d.]+)\nanpr_notificacion_latencia_seconds_count\{tipo="acceso.no_registrado"\} (\d+)/);
  if (lat) console.log(`  latencia media captura→notificación (no_registrado): ${(Number(lat[1]) / Number(lat[2]) * 1000).toFixed(0)} ms`);
  r = await axios.get(`${B}/notificaciones`, h(gestor.token));
  ok(r.data.items.length > 0 && typeof r.data.no_leidas === 'number', `bandeja del gestor: ${r.data.items.length} notificaciones, ${r.data.no_leidas} sin leer`);

  [sOp, sGe, sAdm].forEach(s => s.disconnect());
  console.log(process.exitCode ? 'E2E CON FALLAS' : 'E2E OK');
})().catch(e => { console.error('ERROR', e.response?.status, e.response?.data || e.message); process.exit(1); });
