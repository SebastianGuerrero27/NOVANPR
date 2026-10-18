import {
  cambiosCamara, describirExclusiones, enmascarar, enmascararEnTexto, fuenteParaMediamtx, leerAlcance, leerCamara, leerExclusiones,
  leerIdCamara, leerIp, leerRoi, leerUrlRtsp, leerUrlVista, MASCARA, parsearExclusiones, parsearRoi, presentarCamara, RE_RUTA_VIDEO,
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

describe('Cámaras · la contraseña guardada solo vuelve al mismo equipo', () => {
  const guardada = 'rtsp://admin:S3cr3t0@10.0.0.5/live';

  it('se restaura con el mismo esquema, host y puerto (mayúsculas y puerto por omisión no cuentan como cambio)', () => {
    expect(restaurarClave(`rtsp://admin:${MASCARA}@10.0.0.5:554/otra`, guardada)).toBe('rtsp://admin:S3cr3t0@10.0.0.5:554/otra');
    expect(restaurarClave(`rtsp://admin:${MASCARA}@CAMARA.local/live`, 'rtsp://admin:x@camara.local/live')).toBe('rtsp://admin:x@CAMARA.local/live');
    expect(restaurarClave(`rtsp://admin:${MASCARA}@[fd00::5]/live`, 'rtsp://admin:x@[fd00::5]:554/live')).toBe('rtsp://admin:x@[fd00::5]/live');
    expect(restaurarClave(`rtsps://admin:${MASCARA}@10.0.0.5:322/live`, 'rtsps://admin:x@10.0.0.5/live')).toBe('rtsps://admin:x@10.0.0.5:322/live');
  });

  it.each([
    ['otro host', `rtsp://admin:${MASCARA}@10.0.0.66/live`],
    ['un host que solo comparte el prefijo', `rtsp://admin:${MASCARA}@10.0.0.55/live`],
    ['otro puerto', `rtsp://admin:${MASCARA}@10.0.0.5:8554/live`],
    ['otro esquema', `rtsps://admin:${MASCARA}@10.0.0.5/live`],
  ])('con %s la máscara no se reemplaza y la validación pide la contraseña', (_caso, url) => {
    expect(restaurarClave(url, guardada)).toBe(url);
    expect(leerUrlRtsp(url, guardada)).toEqual({
      ok: false, error: 'URL RTSP: escriba de nuevo la contraseña de la cámara (la guardada solo se conserva si no cambian el equipo, el puerto ni el esquema).',
    });
  });

  it('la vista solo hereda la contraseña del flujo principal si apunta al mismo equipo', () => {
    const base = { nombre: 'Garita principal', ubicacion: 'Acceso norte', rtsp_url: `rtsp://admin:${MASCARA}@10.0.0.5/101` };
    expect(leerCamara({ ...base, rtsp_url_vista: `rtsp://admin:${MASCARA}@10.0.0.5/102` }, guardada, null))
      .toMatchObject({ ok: true, valor: { rtspVista: 'rtsp://admin:S3cr3t0@10.0.0.5/102' } });
    expect(leerCamara({ ...base, rtsp_url_vista: `rtsp://admin:${MASCARA}@10.0.0.99/102` }, guardada, null))
      .toEqual({ ok: false, error: expect.stringMatching(/^URL del flujo de vista: escriba de nuevo la contraseña/) });
  });

  it('el esquema se guarda en minúsculas (MediaMTX rechaza «RTSP://»)', () => {
    expect(leerUrlRtsp('RTSP://admin:clave@10.0.0.5/live')).toEqual({ ok: true, valor: 'rtsp://admin:clave@10.0.0.5/live' });
    expect(leerUrlRtsp('Rtsps://10.0.0.5/live')).toEqual({ ok: true, valor: 'rtsps://10.0.0.5/live' });
    expect(leerUrlRtsp(`RTSP://admin:${MASCARA}@10.0.0.5/live`, guardada)).toEqual({ ok: true, valor: guardada });
  });
});

describe('Cámaras · contraseñas fuera de los mensajes y fuente para MediaMTX', () => {
  it('enmascara las contraseñas de las URL que aparecen dentro de un texto libre (errores de MediaMTX)', () => {
    const error = `HTTP 400 {"status":"error","error":"invalid source: 'RTSP://admin:Clave@Secreta123@10.0.0.5:554/x'"} y rtsp://u:otra@h/y`;
    const r = enmascararEnTexto(error);
    expect(r).not.toMatch(/Clave|Secreta123|otra/);
    expect(r).toContain(`'RTSP://admin:${MASCARA}@10.0.0.5:554/x'`);
    expect(r).toContain(`rtsp://u:${MASCARA}@h/y`);
    expect(enmascararEnTexto('MediaMTX POST /v3/config/paths/add/cam_1: HTTP 500')).toBe('MediaMTX POST /v3/config/paths/add/cam_1: HTTP 500');
    expect(enmascararEnTexto("'rtsp://10.0.0.5:554/live@1'")).toBe("'rtsp://10.0.0.5:554/live@1'");
  });

  it('fuente para MediaMTX: esquema en minúsculas; una URL ya válida no cambia', () => {
    expect(fuenteParaMediamtx('RTSP://admin:Ecu%40911@10.0.0.5:554/Streaming/Channels/101'))
      .toBe('rtsp://admin:Ecu%40911@10.0.0.5:554/Streaming/Channels/101');
    expect(fuenteParaMediamtx('rtsp://10.0.0.5/live?canal=1')).toBe('rtsp://10.0.0.5/live?canal=1');
    expect(fuenteParaMediamtx('rtsp://admin:abc@def@10.0.0.5/live')).toBe('rtsp://admin:abc@def@10.0.0.5/live');
  });

  it('fuente para MediaMTX: codifica lo que su lector rechaza sin cambiar la credencial', () => {
    expect(fuenteParaMediamtx('rtsp://admin:mi clave@10.0.0.5/live')).toBe('rtsp://admin:mi%20clave@10.0.0.5/live');
    expect(fuenteParaMediamtx('rtsp://admin:50%off@10.0.0.5/canal%zz')).toBe('rtsp://admin:50%25off@10.0.0.5/canal%25zz');
    expect(fuenteParaMediamtx('rtsp://admin:clave😀ñ@10.0.0.5/live')).toBe(`rtsp://admin:clave${encodeURIComponent('😀ñ')}@10.0.0.5/live`);
    // Al decodificar (lo que hace MediaMTX antes de autenticarse) vuelve la contraseña original
    const u = fuenteParaMediamtx('rtsp://admin:mi clave 50%@10.0.0.5/live');
    expect(decodeURIComponent(u.slice('rtsp://admin:'.length, u.lastIndexOf('@')))).toBe('mi clave 50%');
  });
});

describe('Cámaras · validación del formulario', () => {
  const valida = {
    nombre: 'Garita principal - entrada', ubicacion: 'Acceso norte, Samborondón (km 1.5)',
    rtsp_url: 'rtsp://admin:clave@192.168.1.64:554/Streaming/Channels/101',
  };

  it('acepta datos válidos: textos recortados e IP opcional', () => {
    expect(leerCamara({ ...valida, nombre: '  Garita   principal ' })).toEqual({
      ok: true, valor: { nombre: 'Garita principal', ubicacion: valida.ubicacion, rtsp: valida.rtsp_url, rtspVista: null, ip: null, direccion: 'ingreso' },
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

describe('Cámaras · flujo de vista', () => {
  const valida = {
    nombre: 'Garita principal', ubicacion: 'Acceso norte',
    rtsp_url: 'rtsp://admin:Ecu%40911@192.168.1.64:554/Streaming/Channels/101',
  };

  it('es opcional: vacío o ausente = la vista usa el flujo principal', () => {
    for (const rtsp_url_vista of [undefined, null, '', '   ']) {
      expect(leerCamara({ ...valida, rtsp_url_vista })).toMatchObject({ ok: true, valor: { rtspVista: null } });
    }
    expect(leerUrlVista('rtsp://admin:x@192.168.1.64:554/Streaming/Channels/102'))
      .toEqual({ ok: true, valor: 'rtsp://admin:x@192.168.1.64:554/Streaming/Channels/102' });
  });

  it('se valida como la URL principal, con su propio mensaje', () => {
    expect(leerCamara({ ...valida, rtsp_url_vista: 'http://192.168.1.64/102' }))
      .toEqual({ ok: false, error: 'Ingrese una URL del flujo de vista válida (rtsp://…).' });
    expect(leerUrlVista(`rtsp://192.168.1.64/${'a'.repeat(240)}`))
      .toEqual({ ok: false, error: 'URL del flujo de vista: máximo 255 caracteres.' });
  });

  it('enmascarada, recupera la contraseña de la vista guardada o, si no había vista, la del flujo principal', () => {
    const vista = `rtsp://admin:${MASCARA}@192.168.1.64:554/Streaming/Channels/102`;
    expect(leerCamara({ ...valida, rtsp_url_vista: vista }, valida.rtsp_url, 'rtsp://admin:propia@192.168.1.64:554/Streaming/Channels/102'))
      .toMatchObject({ ok: true, valor: { rtspVista: 'rtsp://admin:propia@192.168.1.64:554/Streaming/Channels/102' } });
    expect(leerCamara({ ...valida, rtsp_url_vista: vista }, valida.rtsp_url, null))
      .toMatchObject({ ok: true, valor: { rtspVista: 'rtsp://admin:Ecu%40911@192.168.1.64:554/Streaming/Channels/102' } });
  });

  it('la auditoría registra el cambio de la URL de vista y la API la entrega enmascarada', () => {
    const datos = { nombre: 'Garita', ubicacion: 'Acceso', rtsp: 'rtsp://a', rtspVista: 'rtsp://b', ip: '10.0.0.5', direccion: 'ingreso' as const };
    expect(cambiosCamara({ nombre: 'Garita', ubicacion: 'Acceso', rtsp_url: 'rtsp://a', rtsp_url_vista: null, ip: '10.0.0.5' }, datos))
      .toEqual(['URL de vista']);
    expect(presentarCamara({
      id: 1, nombre: 'Garita', ip: '10.0.0.5', rtsp_url: 'rtsp://admin:clave@10.0.0.5/101', rtsp_url_vista: 'rtsp://admin:clave@10.0.0.5/102',
      ubicacion: 'Acceso', activa: 1, estado: null, ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null,
      created_at: new Date(), roi: null,
    }).rtsp_url_vista).toBe(`rtsp://admin:${MASCARA}@10.0.0.5/102`);
  });

  it('rutas de video consultables: cam_<id>, cam_<id>_vista y rutas de prueba', () => {
    for (const ruta of ['cam_3', 'cam_3_vista', 'prueba_0123456789ab']) expect(RE_RUTA_VIDEO.test(ruta)).toBe(true);
    for (const ruta of ['cam_3_otra', 'cam_vista', 'cam_3_vista_x', '../cam_3']) expect(RE_RUTA_VIDEO.test(ruta)).toBe(false);
  });
});

describe('Cámaras · zonas de exclusión', () => {
  const bandera = [[0.7, 0], [1, 0], [1, 0.25], [0.7, 0.25]];

  it('hasta 8 polígonos con las reglas de la región, redondeados; null o [] = ninguna', () => {
    expect(leerExclusiones([bandera, [[0.123456, 0.5], [0.2, 0.5], [0.2, 0.6]]]))
      .toEqual({ ok: true, valor: [bandera, [[0.1235, 0.5], [0.2, 0.5], [0.2, 0.6]]] });
    expect(leerExclusiones(null)).toEqual({ ok: true, valor: [] });
    expect(leerExclusiones([])).toEqual({ ok: true, valor: [] });
    expect(leerExclusiones(Array.from({ length: 8 }, () => bandera)).ok).toBe(true);
    expect(leerExclusiones(Array.from({ length: 9 }, () => bandera))).toEqual({ ok: false, error: 'Máximo 8 zonas de exclusión.' });
    expect(leerExclusiones([[]])).toEqual({ ok: false, error: 'Zona de exclusión 1: debe tener entre 3 y 12 vértices.' });
    expect(leerExclusiones({})).toEqual({ ok: false, error: 'Las zonas de exclusión deben ser una lista de polígonos.' });
  });

  it('guardadas como JSON: se interpretan; lo ilegible o inválido no rompe la cámara', () => {
    expect(parsearExclusiones(JSON.stringify([bandera]))).toEqual([bandera]);
    for (const malo of [null, '', '{no json', '[[[0,0],[2,2],[1,1]]]', 7]) expect(parsearExclusiones(malo)).toEqual([]);
    expect(presentarCamara({
      id: 1, nombre: 'Garita', ip: '10.0.0.5', rtsp_url: 'rtsp://10.0.0.5/101', ubicacion: 'Acceso', activa: 1, estado: null,
      ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null, created_at: new Date(), roi: null, exclusiones: JSON.stringify([bandera]),
    }).exclusiones).toEqual([bandera]);
    expect(describirExclusiones(0)).toBe('sin zonas de exclusión');
    expect(describirExclusiones(1)).toBe('1 zona de exclusión');
    expect(describirExclusiones(3)).toBe('3 zonas de exclusión');
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
      rtsp_url_vista: null, tiene_credenciales: true, activa: true, estado: 'SIN_VERIFICAR', ultimo_ping: null, tiempo_respuesta_ms: null,
      mensaje_ping: null, created_at: creada, detecciones: 2, roi: [[0, 0], [1, 0], [1, 1]], exclusiones: [], direccion: 'ingreso',
    });
  });

  it('alcance del ticket: stream por omisión y único valor (la webcam de pruebas se retiró)', () => {
    expect(leerAlcance(undefined)).toEqual({ ok: true, valor: 'stream' });
    expect(leerAlcance(null)).toEqual({ ok: true, valor: 'stream' });
    expect(leerAlcance('')).toEqual({ ok: true, valor: 'stream' });
    expect(leerAlcance('stream')).toEqual({ ok: true, valor: 'stream' });
    for (const malo of ['webcam', 'Webcam', ' stream', 'video', 1, true]) {
      expect(leerAlcance(malo)).toEqual({ ok: false, error: 'Alcance inválido. Valores: stream.' });
    }
  });
});
