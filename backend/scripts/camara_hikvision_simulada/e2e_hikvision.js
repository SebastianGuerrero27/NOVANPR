#!/usr/bin/env node
/**
 * Prueba de punta a punta con la cámara Hikvision simulada (camara-hik): principal H.265 1080p,
 * secundario H.264 640×360, autenticación Digest y contraseña con símbolos. La orquesta e2e.sh;
 * corre dentro del contenedor anpr-backend (usa JWT_SECRET y la base de datos de su entorno) y
 * firma la sesión del primer administrador activo.
 *
 *   node e2e_hikvision.js crear              registra la cámara, verifica cifrado, Digest y video; asigna el motor
 *   node e2e_hikvision.js estado <id>        estado del motor y de las rutas de video (JSON)
 *   node e2e_hikvision.js sonda              diagnóstico con la contraseña correcta e incorrecta
 *   node e2e_hikvision.js limpiar <id> <ant> borra las detecciones de la prueba y la cámara; devuelve el motor
 */
const jwt = require('jsonwebtoken');
const sql = require('mssql');

const B = 'http://localhost:5000/api';
const CLAVE = encodeURIComponent('Ecu911@Garita#26'); // credencial de la cámara simulada (camara.yml)
const URL_101 = `rtsp://admin:${CLAVE}@camara-hik:554/Streaming/Channels/101`;
const URL_102 = `rtsp://admin:${CLAVE}@camara-hik:554/Streaming/Channels/102`;

let ADMIN = null;
let fallas = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fallas++; };
const espera = ms => new Promise(r => setTimeout(r, ms));
async function api(metodo, ruta, cuerpo) {
  const r = await fetch(B + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  let data = null; try { data = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, data };
}
const conectar = () => sql.connect({ user: process.env.DB_USER || 'sa', password: process.env.DB_PASSWORD, server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433), database: process.env.DB_NAME || 'ANPR_ECU911', options: { encrypt: false, trustServerCertificate: true } });

async function sesionAdministrador(pool) {
  const u = (await pool.request().query(`SELECT TOP 1 u.id, u.email, u.nombre_completo FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
    WHERE r.codigo = 'ADMIN' AND u.estado = 'activo' AND u.bloqueado = 0 ORDER BY u.id`)).recordset[0];
  if (!u) throw new Error('No hay un administrador activo en la base.');
  return jwt.sign({ id: u.id, email: u.email, username: u.email, nombre: u.nombre_completo, rol: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

async function crear(pool) {
  const previa = (await pool.request().query("SELECT valor FROM ConfiguracionSistema WHERE clave = 'camara_motor_id'")).recordset[0]?.valor ?? '';
  console.log(`cámara del motor antes de la prueba: ${previa || '(ninguna elegida)'}`);

  // 1. Alta con flujo principal y de vista
  const alta = await api('POST', '/camaras', { nombre: 'Hikvision simulada E2E', ubicacion: 'Laboratorio de pruebas', rtsp_url: URL_101, rtsp_url_vista: URL_102, ip: 'camara-hik' });
  ok(alta.status === 201, `alta: HTTP ${alta.status} ${alta.data?.error ?? ''}`);
  const c = alta.data?.camera;
  if (!c) throw new Error(JSON.stringify(alta.data));
  ok(c.rtsp_url === 'rtsp://admin:******@camara-hik:554/Streaming/Channels/101' && c.rtsp_url_vista === 'rtsp://admin:******@camara-hik:554/Streaming/Channels/102',
    'la API devuelve ambas URL enmascaradas');

  // 2. En la base: contraseña cifrada (AES-256-GCM), nunca en claro
  const fila = (await pool.request().input('id', sql.Int, c.id).query('SELECT rtsp_url, rtsp_url_vista FROM Camaras WHERE id = @id')).recordset[0];
  const cifrada = u => /^rtsp:\/\/admin:enc\.v1\.[\w-]+\.[\w-]+@camara-hik:554\//.test(u) && !u.includes('Ecu911') && !u.includes('Garita');
  ok(cifrada(fila.rtsp_url) && cifrada(fila.rtsp_url_vista), 'en la base ambas contraseñas están cifradas (enc.v1)');

  // 3. Diagnóstico RTSP (DESCRIBE con Digest) desde la URL enmascarada del formulario
  const p1 = await api('POST', '/camaras/probar', { rtsp_url: c.rtsp_url, camara_id: c.id });
  ok(p1.data?.rtsp?.en_linea === true, `diagnóstico del principal: ${p1.data?.rtsp?.mensaje} (${p1.data?.rtsp?.tiempo_ms} ms, servidor ${p1.data?.rtsp?.servidor ?? '—'})`);
  const p2 = await api('POST', '/camaras/probar', { rtsp_url: c.rtsp_url_vista, camara_id: c.id, vista: true });
  ok(p2.data?.rtsp?.en_linea === true, `diagnóstico del secundario: ${p2.data?.rtsp?.mensaje}`);
  const p3 = await api('POST', '/camaras/probar', { rtsp_url: 'rtsp://camara-hik:554/Streaming/Channels/101' });
  ok(p3.data?.rtsp?.diagnostico === 'requiere_credenciales', `sin usuario → ${p3.data?.rtsp?.diagnostico}`);

  // 4. Edición sin volver a escribir la contraseña: se conserva (y se vuelve a cifrar)
  const ed = await api('PUT', `/camaras/${c.id}`, { nombre: 'Hikvision simulada E2E', ubicacion: 'Laboratorio de pruebas', rtsp_url: c.rtsp_url, rtsp_url_vista: c.rtsp_url_vista, ip: 'camara-hik' });
  ok(ed.status === 200, `edición con las URL enmascaradas: HTTP ${ed.status} ${ed.data?.error ?? ''}`);
  const p4 = await api('POST', `/camaras/${c.id}/ping`);
  ok(p4.data?.rtsp?.en_linea === true, `después de editar la cámara sigue conectando (${p4.data?.rtsp?.mensaje})`);

  // 5. Rutas de video
  const v = await api('POST', `/camaras/${c.id}/video`);
  ok(v.data?.ruta === `cam_${c.id}` && v.data?.ruta_vista === `cam_${c.id}_vista`, `rutas de video: ${v.data?.ruta} y ${v.data?.ruta_vista}`);

  // 6. El motor procesa el principal (H.265) a través de MediaMTX
  const t0 = Date.now();
  const cambio = await api('POST', '/monitoreo/camara-activa', { camara_id: c.id });
  ok(cambio.status === 200, `motor asignado: ${cambio.data?.message ?? cambio.data?.error}`);
  let e = null;
  for (let i = 0; i < 40; i++) {
    e = (await api('GET', '/monitoreo/estado')).data;
    if (e?.camara_activa?.id === c.id && e.camara_activa.conectada && e.enlace?.fps_recibidos > 5) break;
    await espera(500);
  }
  ok(e?.camara_activa?.id === c.id && e.camara_activa.conectada, `el motor recibe video ${((Date.now() - t0) / 1000).toFixed(1)} s después del cambio`);
  ok(/hevc|hev1|h265/i.test(e?.enlace?.codec ?? '') && e.enlace.ancho === 1920 && e.enlace.alto === 1080,
    `enlace del motor: ${e?.enlace?.codec} ${e?.enlace?.ancho}×${e?.enlace?.alto}, ${e?.enlace?.fps_recibidos} fps recibidos`);
  console.log(`ID=${c.id}`);
  console.log(`PREVIA=${previa}`);
}

async function estado(id) {
  const e = (await api('GET', '/monitoreo/estado')).data;
  const r1 = (await api('GET', `/camaras/video/cam_${id}/estado`)).data;
  const r2 = (await api('GET', `/camaras/video/cam_${id}_vista/estado`)).data;
  console.log(JSON.stringify({ captura: e?.fps_captura, analisis: e?.fps_procesamiento, conectada: e?.camara_activa?.conectada, enlace: e?.enlace,
    principal: r1, vista: r2 }));
}

async function sonda() {
  const t0 = Date.now();
  const bien = await api('POST', '/camaras/probar', { rtsp_url: URL_101 });
  ok(bien.data?.rtsp?.en_linea === true, `contraseña correcta → ${bien.data?.rtsp?.diagnostico} (${Date.now() - t0} ms)`);
  const t1 = Date.now();
  const mal = await api('POST', '/camaras/probar', { rtsp_url: URL_101.replace(CLAVE, 'incorrecta') });
  ok(mal.data?.rtsp?.diagnostico === 'credenciales_invalidas', `contraseña incorrecta → ${mal.data?.rtsp?.diagnostico} (${Date.now() - t1} ms)`);
}

async function limpiar(pool, id, previa) {
  const det = (await pool.request().input('id', sql.Int, id).query(
    'SELECT id, placa_reconocida, confianza_ocr FROM DeteccionVehiculo WHERE camara_id = @id ORDER BY id')).recordset;
  console.log(`detecciones registradas por la cámara simulada: ${det.length} → ${det.map(d => `${d.placa_reconocida ?? '—'}(${d.confianza_ocr?.toFixed?.(2) ?? '—'})`).join(', ')}`);
  if (previa && Number(previa) !== id) {
    const r = await api('POST', '/monitoreo/camara-activa', { camara_id: Number(previa) });
    console.log(`motor devuelto a la cámara ${previa}: ${r.data?.message ?? r.data?.error}`);
  }
  for (const d of det) {
    const r = await api('DELETE', `/detecciones/${d.id}`, { motivo: 'Prueba de punta a punta con la cámara Hikvision simulada' });
    if (r.status !== 200) console.log(`  no se pudo borrar la detección ${d.id}: ${r.data?.error}`);
  }
  const b = await api('DELETE', `/camaras/${id}`);
  ok(b.status === 200, `cámara de prueba eliminada: HTTP ${b.status} ${b.data?.error ?? ''}`);
  if (!previa) {
    // Antes de la prueba no había cámara elegida para el motor: se quita la que dejó la prueba
    const r = await pool.request().input('id', sql.NVarChar(20), String(id))
      .query("DELETE FROM ConfiguracionSistema WHERE clave = 'camara_motor_id' AND valor = @id");
    console.log(`configuración del motor restaurada (${r.rowsAffected[0]} fila)`);
  }
}

(async () => {
  const [accion, a, b] = process.argv.slice(2);
  let pool = null;
  try {
    pool = await conectar();
    ADMIN = await sesionAdministrador(pool);
    if (accion === 'crear') await crear(pool);
    else if (accion === 'estado') await estado(Number(a));
    else if (accion === 'sonda') await sonda();
    else if (accion === 'limpiar') await limpiar(pool, Number(a), b);
    else throw new Error(`acción desconocida: ${accion}`);
  } catch (err) {
    console.log(`✘ ${err.message}`);
    fallas++;
  } finally {
    await pool?.close();
  }
  if (accion !== 'estado') console.log(fallas ? `${fallas} verificación(es) fallaron` : 'todas las verificaciones pasaron');
  process.exit(fallas ? 1 : 0);
})();
