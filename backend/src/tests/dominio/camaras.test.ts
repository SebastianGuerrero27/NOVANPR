import {
  enmascarar, leerAlcance, leerCamara, leerIdCamara, leerIp, leerRoi, leerUrlRtsp, MASCARA, parsearRoi, presentarCamara,
  restaurarClave, tieneCredenciales,
} from '../../dominio/camaras';

describe('Cámaras · credenciales RTSP', () => {
  it('enmascara la contraseña en rtsp:// y rtsps:// (la API nunca la devuelve)', () => {
    expect(enmascarar('rtsp://admin:clave@10.0.0.5:554/101')).toBe(`rtsp://admin:${MASCARA}@10.0.0.5:554/101`);
    expect(enmascarar('RTSPS://admin:clave@camara.local/live')).toBe(`RTSPS://admin:${MASCARA}@camara.local/live`);
    expect(enmascarar('rtsp://10.0.0.5/101')).toBe('rtsp://10.0.0.5/101');
    expect(tieneCredenciales('rtsps://admin:clave@camara.local/live')).toBe(true);
    expect(tieneCredenciales('rtsp://admin@10.0.0.5/101')).toBe(false);
  });

  it('enmascara la contraseña completa con usuario vacío o con «@» en la contraseña (como la lee la conexión)', () => {
    expect(enmascarar('rtsp://:S3cr3t0@10.0.0.5/live')).toBe(`rtsp://:${MASCARA}@10.0.0.5/live`);
    expect(enmascarar('rtsp://admin:abc@S3cr3t0@10.0.0.5/live')).toBe(`rtsp://admin:${MASCARA}@10.0.0.5/live`);
    // Misma lectura que la clase URL (WHATWG): la contraseña llega hasta la última «@» de la autoridad
    expect(new URL('rtsp://admin:abc@S3cr3t0@10.0.0.5/live').password).toBe('abc%40S3cr3t0');
    // El puerto no es una contraseña y una «@» de la ruta no abre credenciales
    expect(enmascarar('rtsp://10.0.0.5:554/live@1')).toBe('rtsp://10.0.0.5:554/live@1');
    expect(tieneCredenciales('rtsp://usuario@10.0.0.5:554/101')).toBe(false);
    expect(tieneCredenciales('rtsp://usuario:@10.0.0.5/101')).toBe(false);
  });

  it('solo restaura la máscara puesta en el lugar de la contraseña', () => {
    const guardada = 'rtsp://admin:S3cr3t0@10.0.0.5/live';
    // En la ruta o en el usuario la máscara es texto: la contraseña no se copia ahí (quedaría a la vista)
    expect(restaurarClave(`rtsp://10.0.0.5/${MASCARA}`, guardada)).toBe(`rtsp://10.0.0.5/${MASCARA}`);
    expect(restaurarClave(`rtsp://${MASCARA}:otra@10.0.0.5/live`, guardada)).toBe(`rtsp://${MASCARA}:otra@10.0.0.5/live`);
    // Contraseña guardada con «@»: se recupera completa
    expect(restaurarClave(`rtsp://admin:${MASCARA}@10.0.0.5/live`, 'rtsp://admin:abc@S3cr3t0@10.0.0.5/live'))
      .toBe('rtsp://admin:abc@S3cr3t0@10.0.0.5/live');
  });

  it('restaura la contraseña guardada de forma literal (incluso con $& o $1)', () => {
    const guardada = 'rtsp://admin:a$&b$1@10.0.0.5/101';
    expect(restaurarClave(`rtsp://admin:${MASCARA}@10.0.0.5/101`, guardada)).toBe(guardada);
    // Cambió el usuario o la ruta pero conservó la contraseña
    expect(restaurarClave(`rtsp://operador:${MASCARA}@10.0.0.5/102`, guardada)).toBe('rtsp://operador:a$&b$1@10.0.0.5/102');
    // Contraseña nueva, o nada guardado que recuperar: la URL queda igual
    expect(restaurarClave('rtsp://admin:nueva@10.0.0.5/101', guardada)).toBe('rtsp://admin:nueva@10.0.0.5/101');
    expect(restaurarClave(`rtsp://admin:${MASCARA}@10.0.0.5/101`, 'rtsp://10.0.0.5/101')).toBe(`rtsp://admin:${MASCARA}@10.0.0.5/101`);
    expect(restaurarClave(`rtsp://admin:${MASCARA}@10.0.0.5/101`, null)).toBe(`rtsp://admin:${MASCARA}@10.0.0.5/101`);
  });
});

describe('Cámaras · validación del formulario', () => {
  const valida = {
    nombre: 'Garita principal - entrada', ubicacion: 'Acceso norte, Samborondón (km 1.5)',
    rtsp_url: 'rtsp://admin:clave@192.168.1.64:554/Streaming/Channels/101',
  };

  it('acepta datos válidos: textos recortados e IP opcional', () => {
    expect(leerCamara({ ...valida, nombre: '  Garita   principal ' })).toEqual({
      ok: true, valor: { nombre: 'Garita principal', ubicacion: valida.ubicacion, rtsp: valida.rtsp_url, ip: null },
    });
    expect(leerCamara({ ...valida, ip: ' 192.168.1.64 ' })).toMatchObject({ ok: true, valor: { ip: '192.168.1.64' } });
    expect(leerCamara(null)).toEqual({ ok: false, error: 'El campo «Nombre» es obligatorio.' });
  });

  it.each([
    ['nombre', '', 'El campo «Nombre» es obligatorio.'],
    ['nombre', 'AB', 'Nombre: mínimo 3 caracteres.'],
    ['nombre', 'Cámara_1', 'Nombre: letras, números, espacios y . , / # ( ) -.'],
    ['ubicacion', 'Patio <img src=x>', 'Ubicación: letras, números, espacios y . , / # ( ) -.'],
    ['rtsp_url', 'rtmp://192.168.1.64/live', 'Ingrese una URL RTSP válida (rtsp://…).'],
    ['rtsp_url', 'rtsp://192.168.1.64/canal 1', 'Ingrese una URL RTSP válida (rtsp://…).'],
    ['ip', '192.168.1.256', 'IP o host inválido.'],
    ['ip', '-camara', 'IP o host inválido.'],
  ])('rechaza %s = %p', (campo, valor, error) => {
    expect(leerCamara({ ...valida, [campo]: valor })).toEqual({ ok: false, error });
  });

  it('URL RTSP: rtsp:// o rtsps://, con algo tras el esquema y máximo 255 caracteres', () => {
    expect(leerUrlRtsp(' rtsps://camara.local:322/live ')).toEqual({ ok: true, valor: 'rtsps://camara.local:322/live' });
    const base = 'rtsp://192.168.1.64/';
    expect(leerUrlRtsp(base + 'a'.repeat(255 - base.length)).ok).toBe(true);
    expect(leerUrlRtsp(base + 'a'.repeat(256 - base.length)).ok).toBe(false);
    expect(leerUrlRtsp('rtsp://').ok).toBe(false);
    expect(leerUrlRtsp(base + 'a'.repeat(256 - base.length))).toEqual({ ok: false, error: 'URL RTSP: máximo 255 caracteres.' });
  });

  it('URL RTSP: obligatoria y solo texto (un arreglo no se convierte en URL)', () => {
    expect(leerUrlRtsp(undefined)).toEqual({ ok: false, error: 'El campo «URL RTSP» es obligatorio.' });
    expect(leerUrlRtsp('  ')).toEqual({ ok: false, error: 'El campo «URL RTSP» es obligatorio.' });
    expect(leerUrlRtsp(['rtsp://10.0.0.5/live'])).toEqual({ ok: false, error: 'Ingrese una URL RTSP válida (rtsp://…).' });
  });

  it('el formato se exige a lo escrito: una cámara antigua con espacio en la contraseña se edita sin reescribirla', () => {
    const antigua = 'rtsp://admin:mi clave@10.0.0.5/live';
    expect(leerUrlRtsp(`rtsp://admin:${MASCARA}@10.0.0.5/live`, antigua)).toEqual({ ok: true, valor: antigua });
    expect(leerUrlRtsp('rtsp://admin:mi clave@10.0.0.5/live').ok).toBe(false);
  });

  it('IP o host: IPv4 o nombre de host de hasta 45 caracteres; vacío = se toma el host de la URL', () => {
    expect(leerIp('')).toEqual({ ok: true, valor: null });
    expect(leerIp(undefined)).toEqual({ ok: true, valor: null });
    expect(leerIp('camara-norte.ecu911.local')).toEqual({ ok: true, valor: 'camara-norte.ecu911.local' });
    expect(leerIp(`${'a'.repeat(40)}.local`)).toEqual({ ok: false, error: 'IP o host: máximo 45 caracteres.' });
  });

  it('id de cámara recibido en el cuerpo: entero positivo dentro del rango de la columna INT', () => {
    expect(leerIdCamara(undefined)).toEqual({ ok: true, valor: null });
    expect(leerIdCamara('7')).toEqual({ ok: true, valor: 7 });
    expect(leerIdCamara(undefined, true).ok).toBe(false);
    for (const malo of [0, -1, 2.5, 'x1', 2147483648]) expect(leerIdCamara(malo).ok).toBe(false);
  });
});

describe('Cámaras · región de interés', () => {
  it('polígono de 3 a 12 vértices normalizados, redondeado a 4 decimales; null o [] = cuadro completo', () => {
    expect(leerRoi([[0, 0], [1, 0], [0.33333333, 1]])).toEqual({ ok: true, valor: [[0, 0], [1, 0], [0.3333, 1]] });
    expect(leerRoi(Array.from({ length: 12 }, () => [0.5, 0.5])).ok).toBe(true);
    expect(leerRoi(null)).toEqual({ ok: true, valor: null });
    expect(leerRoi([])).toEqual({ ok: true, valor: null });
    expect(leerRoi({ 0: [0, 0], 1: [1, 0], 2: [1, 1] }).ok).toBe(false);
    expect(leerRoi([[0, 0], [1, 0], [0.5, Number.NaN]]).ok).toBe(false);
    expect(leerRoi([[0, 0], [1, 0], [0.5, 0.5, 0.5]]).ok).toBe(false);
  });

  it('región guardada: JSON válido → polígono; dañado o fuera de las reglas → null', () => {
    expect(parsearRoi('[[0.1,0.1],[0.9,0.1],[0.5,0.9]]')).toEqual([[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]]);
    expect(parsearRoi('[[0.1,0.1],[0.9,0.1]]')).toBeNull();
    expect(parsearRoi('{no es json')).toBeNull();
    expect(parsearRoi('')).toBeNull();
    expect(parsearRoi(null)).toBeNull();
  });
});

describe('Cámaras · presentación y alcance del ticket', () => {
  it('presentarCamara: el formato del listado y del detalle, sin la contraseña', () => {
    const creada = new Date('2026-10-01T00:00:00Z');
    expect(presentarCamara({
      id: 1, nombre: 'Garita', ip: '10.0.0.5', rtsp_url: 'rtsp://admin:clave@10.0.0.5/101', ubicacion: 'Acceso',
      activa: 1, estado: null, ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null, created_at: creada,
      detecciones: 2, roi: '[[0,0],[1,0],[1,1]]',
    })).toEqual({
      id: 1, nombre: 'Garita', ip: '10.0.0.5', ubicacion: 'Acceso', rtsp_url: `rtsp://admin:${MASCARA}@10.0.0.5/101`,
      tiene_credenciales: true, activa: true, estado: 'SIN_VERIFICAR', ultimo_ping: null, tiempo_respuesta_ms: null,
      mensaje_ping: null, created_at: creada, detecciones: 2, roi: [[0, 0], [1, 0], [1, 1]],
    });
  });

  it('alcance del ticket: stream por omisión; solo los valores exactos stream o webcam', () => {
    expect(leerAlcance(undefined)).toEqual({ ok: true, valor: 'stream' });
    expect(leerAlcance(null)).toEqual({ ok: true, valor: 'stream' });
    expect(leerAlcance('')).toEqual({ ok: true, valor: 'stream' });
    expect(leerAlcance('webcam')).toEqual({ ok: true, valor: 'webcam' });
    for (const malo of ['Webcam', ' stream', 'video', 1, true]) {
      expect(leerAlcance(malo)).toEqual({ ok: false, error: 'Alcance inválido. Valores: stream, webcam.' });
    }
  });
});
