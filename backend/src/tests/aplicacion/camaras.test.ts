import {
  casosCamaras, type DiagnosticoCamara, type PuertoConectividad, type PuertoCustodiaCredenciales, type PuertoMotorAnpr,
  type PuertoServidorVideo, type PuertoTickets, type RepositorioCamaras, type ResultadoRtsp,
} from '../../aplicacion/camaras';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import type { AlcanceTicket, CamaraGuardada } from '../../dominio/camaras';

/** Casos de uso de las cámaras con dobles de prueba: sin base de datos, sin red, sin MediaMTX ni motor ANPR. */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administrador', rol: 'Admin', ip: '10.0.0.1' };

/** Contraseña con `$&`: al restaurarla no debe interpretarse como patrón de reemplazo. */
const CLAVE = 'S3cr$&t';
const URL_GUARDADA = `rtsp://admin:${CLAVE}@192.168.1.64:554/Streaming/Channels/101`;
const URL_ENMASCARADA = 'rtsp://admin:******@192.168.1.64:554/Streaming/Channels/101';
const VALIDA = { nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', rtsp_url: URL_GUARDADA };

const guardada = (extra: Partial<CamaraGuardada> = {}): CamaraGuardada => ({
  id: 3, nombre: 'Garita norte', ip: '192.168.1.64', rtsp_url: URL_GUARDADA, ubicacion: 'Acceso vehicular norte',
  activa: true, estado: 'EN_LINEA', ultimo_ping: null, tiempo_respuesta_ms: 12, mensaje_ping: 'Flujo de video disponible',
  created_at: new Date('2026-10-01T08:00:00Z'), detecciones: 0, roi: null, ...extra,
});

const RTSP_OK: ResultadoRtsp = {
  host: '192.168.1.64', puerto: 554, en_linea: true, diagnostico: 'ok', tiempo_ms: 12, mensaje: 'Flujo de video disponible',
};
const DIAGNOSTICO: DiagnosticoCamara = {
  ping: { host: '192.168.1.64', responde: true, tiempo_ms: 1, mensaje: 'El equipo responde al ping' }, rtsp: RTSP_OK,
};

/** Host de la URL (o la IP indicada), como destinoRtsp; null si la URL no tiene host. */
const destinoDoble = (rtsp: string, ip: string | null) => {
  const host = ip || rtsp.match(/^rtsps?:\/\/(?:[^@/]*@)?([^:/?#]+)/i)?.[1];
  return host ? { host } : null;
};

/** Custodia que deja la URL igual (la mayoría de las pruebas no se ocupan del cifrado). */
const custodiaNeutra = (): jest.Mocked<PuertoCustodiaCredenciales> => ({ proteger: jest.fn(u => u), revelar: jest.fn(u => u) });

/** Custodia que marca la contraseña protegida («P(…)») para comprobar cuándo se protege y se revela. */
const custodiaMarcada = (): jest.Mocked<PuertoCustodiaCredenciales> => ({
  proteger: jest.fn(u => u.replace(/^(rtsps?:\/\/[^:/?#]*:)(?!P\()([^/?#]+)@/i, '$1P($2)@')),
  revelar: jest.fn(u => u.replace(/^(rtsps?:\/\/[^:/?#]*:)P\(([^/?#]+)\)@/i, '$1$2@')),
});

function preparar(camara: CamaraGuardada | null = guardada(), custodia = custodiaNeutra()) {
  const repositorio: jest.Mocked<RepositorioCamaras> = {
    listar: jest.fn().mockResolvedValue(camara ? [camara] : []),
    obtener: jest.fn().mockImplementation(async (id: number) => (camara ? { ...camara, id } : null)),
    conexion: jest.fn().mockResolvedValue(camara
      ? { id: camara.id, nombre: camara.nombre, ip: camara.ip, rtsp_url: camara.rtsp_url, rtsp_url_vista: camara.rtsp_url_vista ?? null,
        activa: Boolean(camara.activa) }
      : null),
    habilitadas: jest.fn().mockResolvedValue([]),
    crear: jest.fn().mockResolvedValue(7),
    actualizar: jest.fn().mockResolvedValue(undefined),
    alternarActiva: jest.fn().mockResolvedValue(camara ? { nombre: camara.nombre, activa: false } : null),
    fijarZonas: jest.fn().mockResolvedValue(camara ? camara.nombre : null),
    eliminar: jest.fn().mockResolvedValue(undefined),
  };
  const conectividad: jest.Mocked<PuertoConectividad> = {
    destino: jest.fn(destinoDoble),
    probar: jest.fn().mockResolvedValue(RTSP_OK),
    diagnosticar: jest.fn().mockResolvedValue(DIAGNOSTICO),
    verificarRed: jest.fn().mockResolvedValue(null),
    registrar: jest.fn().mockResolvedValue(undefined),
  };
  const video: jest.Mocked<PuertoServidorVideo> = {
    rutaCamara: jest.fn((id: number) => `cam_${id}`),
    rutaVista: jest.fn((id: number) => `cam_${id}_vista`),
    urlLecturaMotor: jest.fn((ruta: string) => `rtsp://anpr:token@mediamtx:8554/${ruta}`),
    urlWebrtc: jest.fn(() => 'https://video.ecu911.local'),
    sincronizarRutas: jest.fn().mockResolvedValue(undefined),
    crearRutaPrueba: jest.fn().mockResolvedValue('prueba_0123456789ab'),
    eliminarRutaPrueba: jest.fn().mockResolvedValue(undefined),
    estadoRuta: jest.fn().mockResolvedValue(null),
    camaraDeRuta: jest.fn().mockResolvedValue(null),
  };
  const tickets: jest.Mocked<PuertoTickets> = {
    emitir: jest.fn((usuarioId: number, alcance: AlcanceTicket) => `ticket-${usuarioId}-${alcance}`),
    valido: jest.fn().mockReturnValue(false),
    esMotor: jest.fn().mockReturnValue(false),
  };
  const motor: jest.Mocked<PuertoMotorAnpr> = {
    estado: jest.fn().mockResolvedValue({ en_linea: false }),
    camaraDeseada: jest.fn().mockResolvedValue(null),
    procesa: jest.fn().mockResolvedValue(false),
    guardarCamara: jest.fn().mockResolvedValue(undefined),
    cambiarCamara: jest.fn().mockResolvedValue({}),
    fijarZonas: jest.fn().mockResolvedValue({}),
    sincronizar: jest.fn().mockResolvedValue(false),
    urlPublica: jest.fn(() => 'https://anpr.ecu911.local'),
  };
  const auditoria = { operacion: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emitir: jest.fn() };
  const casos = casosCamaras({ repositorio, custodia, conectividad, video, tickets, motor, auditoria, eventos });
  return { casos, repositorio, custodia, conectividad, video, tickets, motor, auditoria, eventos };
}

/** Tipo y mensaje del ErrorAplicacion que lanza la promesa (cualquier otro error hace fallar la prueba). */
const fallo = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErrorAplicacion) return { tipo: e.tipo, mensaje: e.message };
    throw e;
  }
  throw new Error('se esperaba un error');
};

/** Deja terminar las tareas en segundo plano (verificación de conexión, sincronización con MediaMTX). */
const enCola = () => new Promise(resolve => setImmediate(resolve));

const NO_ENCONTRADA = { tipo: 'no_encontrado', mensaje: 'Cámara no encontrada.' };

describe('Casos de uso · cámaras', () => {
  describe('consulta', () => {
    it('listar y obtener: contraseña enmascarada, credenciales marcadas y región de interés interpretada', async () => {
      const { casos } = preparar(guardada({ roi: '[[0.1,0.2],[0.9,0.2],[0.5,0.9]]', detecciones: 4 }));
      const [c] = await casos.listar();
      expect(c.rtsp_url).toBe(URL_ENMASCARADA);
      expect(JSON.stringify(c)).not.toContain(CLAVE);
      expect(c).toMatchObject({
        id: 3, tiene_credenciales: true, activa: true, estado: 'EN_LINEA', detecciones: 4, roi: [[0.1, 0.2], [0.9, 0.2], [0.5, 0.9]],
      });
      // El detalle tiene el mismo formato que cada elemento del listado
      expect(await casos.obtener(3)).toEqual(c);
    });

    it('obtener: 404 si la cámara no existe', async () => {
      expect(await fallo(preparar(null).casos.obtener(99))).toEqual(NO_ENCONTRADA);
    });
  });

  describe('registrar', () => {
    it('valida, guarda, audita, difunde la cámara enmascarada y verifica la conexión en segundo plano', async () => {
      const { casos, repositorio, auditoria, eventos, conectividad, video, motor } = preparar();
      const camara = await casos.registrar({ nombre: '  Garita   sur ', ubicacion: 'Acceso sur, bloque B', rtsp_url: URL_GUARDADA }, ADMIN);
      // Sin IP indicada, el ping usa el host de la URL
      expect(repositorio.crear).toHaveBeenCalledWith(
        { nombre: 'Garita sur', ubicacion: 'Acceso sur, bloque B', rtsp: URL_GUARDADA, rtspVista: null, ip: '192.168.1.64', direccion: 'ingreso' }, 1);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_ALTA', 'camara', 7, 'Garita sur · Acceso sur, bloque B');
      expect(camara).toMatchObject({ id: 7, rtsp_url: URL_ENMASCARADA });
      expect(eventos.emitir).toHaveBeenCalledWith('camara:actualizada', camara);
      await enCola();
      expect(conectividad.probar).toHaveBeenCalledWith(URL_GUARDADA, '192.168.1.64');
      expect(conectividad.registrar).toHaveBeenCalledWith(7, RTSP_OK, true);
      expect(video.sincronizarRutas).toHaveBeenCalled();
      expect(motor.sincronizar).toHaveBeenCalled();
    });

    it('con IP o host indicado, el ping usa ese equipo', async () => {
      const { casos, repositorio } = preparar();
      await casos.registrar({ ...VALIDA, ip: ' camara-norte.ecu911.local ' }, ADMIN);
      expect(repositorio.crear).toHaveBeenCalledWith(expect.objectContaining({ ip: 'camara-norte.ecu911.local' }), 1);
    });

    it.each([
      ['nombre de 2 caracteres', { nombre: 'ab' }, 'Nombre: mínimo 3 caracteres.'],
      ['nombre de 101 caracteres', { nombre: 'x'.repeat(101) }, 'Nombre: máximo 100 caracteres.'],
      ['nombre con HTML', { nombre: 'Garita <b>norte</b>' }, 'Nombre: letras, números, espacios y . , / # ( ) -.'],
      ['ubicación vacía', { ubicacion: '' }, 'El campo «Ubicación» es obligatorio.'],
      ['ubicación con símbolos', { ubicacion: 'Acceso · norte' }, 'Ubicación: letras, números, espacios y . , / # ( ) -.'],
      ['ubicación de 151 caracteres', { ubicacion: 'y'.repeat(151) }, 'Ubicación: máximo 150 caracteres.'],
      ['URL vacía', { rtsp_url: '' }, 'El campo «URL RTSP» es obligatorio.'],
      ['URL en un arreglo', { rtsp_url: [URL_GUARDADA] }, 'Ingrese una URL RTSP válida (rtsp://…).'],
      ['URL http://', { rtsp_url: 'http://192.168.1.64/stream' }, 'Ingrese una URL RTSP válida (rtsp://…).'],
      ['URL sin nada tras rtsp://', { rtsp_url: 'rtsp://' }, 'Ingrese una URL RTSP válida (rtsp://…).'],
      ['URL con espacios', { rtsp_url: 'rtsp://192.168.1.64/mi flujo' }, 'Ingrese una URL RTSP válida (rtsp://…).'],
      ['URL de 260 caracteres', { rtsp_url: `rtsp://192.168.1.64/${'a'.repeat(240)}` }, 'URL RTSP: máximo 255 caracteres.'],
      ['host de la URL de 47 caracteres sin IP', { rtsp_url: `rtsp://${'a'.repeat(40)}.local1/live` },
        'El host de la URL supera los 45 caracteres: indique la IP de la cámara.'],
      ['URL sin host', { rtsp_url: 'rtsp://:554/stream' }, 'No se pudo determinar el host de la cámara. Revise la URL o la IP.'],
      ['IPv4 fuera de rango', { ip: '300.1.1.1' }, 'IP o host inválido.'],
      ['host con espacios', { ip: 'camara norte' }, 'IP o host inválido.'],
      ['host de 53 caracteres', { ip: `${'a'.repeat(40)}.ecu911.local` }, 'IP o host: máximo 45 caracteres.'],
    ])('rechaza %s sin tocar la base', async (_caso, cambio, mensaje) => {
      const { casos, repositorio, auditoria, eventos } = preparar();
      expect(await fallo(casos.registrar({ ...VALIDA, ...cambio }, ADMIN))).toEqual({ tipo: 'validacion', mensaje });
      expect(repositorio.crear).not.toHaveBeenCalled();
      expect(auditoria.operacion).not.toHaveBeenCalled();
      expect(eventos.emitir).not.toHaveBeenCalled();
    });

    it('un fallo en segundo plano (MediaMTX o la cámara no responden) no afecta el alta', async () => {
      const { casos, video, conectividad } = preparar();
      video.sincronizarRutas.mockRejectedValue(new Error('MediaMTX no responde'));
      conectividad.probar.mockRejectedValue(new Error('timeout'));
      await expect(casos.registrar(VALIDA, ADMIN)).resolves.toMatchObject({ id: 7 });
      await enCola();
      expect(conectividad.registrar).not.toHaveBeenCalled();
    });
  });

  describe('editar', () => {
    it('404 si la cámara no existe, sin validar ni escribir', async () => {
      const { casos, repositorio } = preparar(null);
      expect(await fallo(casos.editar(99, { nombre: 'x' }, ADMIN))).toEqual(NO_ENCONTRADA);
      expect(repositorio.actualizar).not.toHaveBeenCalled();
    });

    it('conserva la contraseña guardada cuando el formulario devuelve la URL enmascarada', async () => {
      const { casos, repositorio, auditoria, eventos, conectividad, video } = preparar();
      const camara = await casos.editar(3, { ...VALIDA, nombre: 'Garita norte 2', rtsp_url: URL_ENMASCARADA }, ADMIN);
      expect(repositorio.actualizar).toHaveBeenCalledWith(3,
        { nombre: 'Garita norte 2', ubicacion: 'Acceso vehicular norte', rtsp: URL_GUARDADA, rtspVista: null, ip: '192.168.1.64', direccion: 'ingreso' });
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_EDICION', 'camara', 3, 'Garita norte 2: nombre');
      // La URL no cambió: no se vuelve a verificar la conexión ni se reconfigura MediaMTX
      await enCola();
      expect(conectividad.probar).not.toHaveBeenCalled();
      expect(video.sincronizarRutas).not.toHaveBeenCalled();
      // La respuesta y el evento en tiempo real siguen sin exponer la contraseña
      expect(camara.rtsp_url).toBe(URL_ENMASCARADA);
      expect(JSON.stringify(eventos.emitir.mock.calls)).not.toContain(CLAVE);
    });

    it('sin cambios: lo deja en la auditoría', async () => {
      const { casos, auditoria } = preparar();
      await casos.editar(3, { ...VALIDA, rtsp_url: URL_ENMASCARADA }, ADMIN);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_EDICION', 'camara', 3, 'Garita norte: sin cambios');
    });

    it('si cambia la URL: audita el cambio, verifica la conexión y reconfigura MediaMTX sin reasignar el motor', async () => {
      const { casos, repositorio, auditoria, conectividad, video, motor } = preparar();
      const nueva = 'rtsp://admin:otra@192.168.1.65:554/Streaming/Channels/102';
      await casos.editar(3, { ...VALIDA, rtsp_url: nueva }, ADMIN);
      expect(repositorio.actualizar).toHaveBeenCalledWith(3,
        { nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', rtsp: nueva, rtspVista: null, ip: '192.168.1.65', direccion: 'ingreso' });
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_EDICION', 'camara', 3, 'Garita norte: URL RTSP, IP');
      await enCola();
      expect(conectividad.registrar).toHaveBeenCalledWith(3, RTSP_OK, true);
      expect(video.sincronizarRutas).toHaveBeenCalledTimes(1);
      // El motor sigue leyendo la misma ruta cam_<id>: MediaMTX reabre la cámara con la URL nueva
      expect(motor.sincronizar).not.toHaveBeenCalled();
    });

    it('rechaza datos inválidos sin actualizar', async () => {
      const { casos, repositorio, auditoria } = preparar();
      for (const cambio of [{ rtsp_url: `${URL_ENMASCARADA}/<script>` }, { nombre: '' }, { ip: '10.0.0.999' }]) {
        expect((await fallo(casos.editar(3, { ...VALIDA, ...cambio }, ADMIN))).tipo).toBe('validacion');
      }
      expect(repositorio.actualizar).not.toHaveBeenCalled();
      expect(auditoria.operacion).not.toHaveBeenCalled();
    });
  });

  describe('habilitación, región de interés y eliminación', () => {
    it('alternar: audita el estado resultante y resincroniza MediaMTX y el motor; 404 si no existe', async () => {
      const { casos, auditoria, eventos, video, motor } = preparar();
      const r = await casos.alternar(3, ADMIN);
      expect(r.activa).toBe(false);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_DESHABILITADA', 'camara', 3, 'Garita norte');
      expect(eventos.emitir).toHaveBeenCalledWith('camara:actualizada', r.camara);
      await enCola();
      expect(video.sincronizarRutas).toHaveBeenCalled();
      expect(motor.sincronizar).toHaveBeenCalled();
      expect(await fallo(preparar(null).casos.alternar(99, ADMIN))).toEqual(NO_ENCONTRADA);
    });

    it.each([
      ['2 vértices', [[0.1, 0.1], [0.9, 0.1]], 'La región de interés debe tener entre 3 y 12 vértices.'],
      ['13 vértices', Array.from({ length: 13 }, () => [0.5, 0.5]), 'La región de interés debe tener entre 3 y 12 vértices.'],
      ['el polígono como texto JSON', '[[0.1,0.1],[0.9,0.1],[0.5,0.9]]', 'La región de interés debe tener entre 3 y 12 vértices.'],
      ['una coordenada mayor que 1', [[0.1, 0.1], [0.9, 0.1], [0.5, 1.2]], 'Cada vértice debe ser [x, y] con valores entre 0 y 1.'],
      ['una coordenada negativa', [[0.1, 0.1], [0.9, 0.1], [-0.1, 0.5]], 'Cada vértice debe ser [x, y] con valores entre 0 y 1.'],
      ['coordenadas como texto', [[0.1, 0.1], [0.9, 0.1], ['0.5', '0.9']], 'Cada vértice debe ser [x, y] con valores entre 0 y 1.'],
      ['un vértice incompleto', [[0.1, 0.1], [0.9, 0.1], [0.5]], 'Cada vértice debe ser [x, y] con valores entre 0 y 1.'],
    ])('fijarZonas: rechaza la región con %s sin tocar la base', async (_caso, roi, mensaje) => {
      const { casos, repositorio, motor } = preparar();
      expect(await fallo(casos.fijarZonas(3, roi, undefined, ADMIN))).toEqual({ tipo: 'validacion', mensaje });
      expect(repositorio.fijarZonas).not.toHaveBeenCalled();
      expect(motor.fijarZonas).not.toHaveBeenCalled();
    });

    it('fijarZonas: guarda la región redondeada, audita y la aplica en el motor; null vuelve al cuadro completo', async () => {
      const { casos, repositorio, auditoria, motor } = preparar();
      const r = await casos.fijarZonas(3, [[0.123456, 0.2], [0.9, 0.2], [0.5, 0.95]], undefined, ADMIN);
      expect(r.roi).toEqual([[0.1235, 0.2], [0.9, 0.2], [0.5, 0.95]]);
      // Sin zonas de exclusión en la solicitud, las guardadas no cambian
      expect(repositorio.fijarZonas).toHaveBeenCalledWith(3, r.roi, undefined);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: región de 3 vértices');
      await enCola();
      expect(motor.fijarZonas).toHaveBeenCalledWith(3, r.roi, []);

      expect((await casos.fijarZonas(3, null, undefined, ADMIN)).roi).toBeNull();
      expect((await casos.fijarZonas(3, [], undefined, ADMIN)).roi).toBeNull();
      expect(auditoria.operacion).toHaveBeenLastCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: cuadro completo');
      expect(await fallo(preparar(null).casos.fijarZonas(99, null, undefined, ADMIN))).toEqual(NO_ENCONTRADA);
    });

    it('fijarZonas: guarda las zonas de exclusión, las audita y el motor recibe el conjunto completo', async () => {
      const { casos, repositorio, auditoria, motor } = preparar();
      const bandera = [[0.7, 0], [1, 0], [1, 0.25], [0.7, 0.25]];
      const vereda = [[0, 0.8], [0.3, 0.8], [0.3, 1], [0, 1]];
      const r = await casos.fijarZonas(3, null, [bandera, vereda], ADMIN);
      expect(r.exclusiones).toEqual([bandera, vereda]);
      expect(repositorio.fijarZonas).toHaveBeenCalledWith(3, null, [bandera, vereda]);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: cuadro completo, 2 zonas de exclusión');
      await enCola();
      expect(motor.fijarZonas).toHaveBeenCalledWith(3, null, [bandera, vereda]);
      // [] o null las quita
      await casos.fijarZonas(3, null, [], ADMIN);
      expect(repositorio.fijarZonas).toHaveBeenLastCalledWith(3, null, []);
      expect(auditoria.operacion).toHaveBeenLastCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: cuadro completo, sin zonas de exclusión');
    });

    it('fijarZonas: solo exclusiones no borra la región guardada; sin ningún campo → 400', async () => {
      const roiGuardada = [[0, 0.2], [1, 0.2], [1, 1]];
      const { casos, repositorio, motor, auditoria } = preparar(guardada({ roi: JSON.stringify(roiGuardada) }));
      const bandera = [[0.7, 0], [1, 0], [1, 0.25]];
      const r = await casos.fijarZonas(3, undefined, [bandera], ADMIN);
      expect(r.roi).toBeUndefined();
      expect(repositorio.fijarZonas).toHaveBeenCalledWith(3, undefined, [bandera]);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: 1 zona de exclusión');
      await enCola();
      expect(motor.fijarZonas).toHaveBeenCalledWith(3, roiGuardada, [bandera]);
      expect(await fallo(casos.fijarZonas(3, undefined, undefined, ADMIN))).toEqual({
        tipo: 'validacion', mensaje: 'Indique la región de interés (roi, null para el cuadro completo) o las zonas de exclusión.',
      });
    });

    it('fijarZonas: sin exclusiones en la solicitud, el motor recibe las que ya estaban guardadas', async () => {
      const guardadas = [[[0.7, 0], [1, 0], [1, 0.25]]];
      const { casos, motor } = preparar(guardada({ exclusiones: JSON.stringify(guardadas) }));
      await casos.fijarZonas(3, [[0.1, 0.2], [0.9, 0.2], [0.5, 0.95]], undefined, ADMIN);
      await enCola();
      expect(motor.fijarZonas).toHaveBeenCalledWith(3, [[0.1, 0.2], [0.9, 0.2], [0.5, 0.95]], guardadas);
    });

    it.each([
      ['un polígono suelto (no una lista)', [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], 'Zona de exclusión 1: debe tener entre 3 y 12 vértices.'],
      ['texto', 'zona', 'Las zonas de exclusión deben ser una lista de polígonos.'],
      ['más de 8 zonas', Array.from({ length: 9 }, () => [[0, 0], [0.1, 0], [0.1, 0.1]]), 'Máximo 8 zonas de exclusión.'],
      ['una zona de 2 vértices', [[[0, 0], [0.1, 0], [0.1, 0.1]], [[0, 0], [1, 1]]], 'Zona de exclusión 2: debe tener entre 3 y 12 vértices.'],
      ['una coordenada fuera de 0–1', [[[0, 0], [1.2, 0], [0.1, 0.1]]], 'Zona de exclusión 1: cada vértice debe ser [x, y] con valores entre 0 y 1.'],
    ])('fijarZonas: rechaza zonas de exclusión con %s sin tocar la base', async (_caso, exclusiones, mensaje) => {
      const { casos, repositorio, motor } = preparar();
      expect(await fallo(casos.fijarZonas(3, null, exclusiones, ADMIN))).toEqual({ tipo: 'validacion', mensaje });
      expect(repositorio.fijarZonas).not.toHaveBeenCalled();
      expect(motor.fijarZonas).not.toHaveBeenCalled();
    });

    it('eliminar: solo sin historial (409 con detecciones); audita y difunde la baja', async () => {
      const conHistorial = preparar(guardada({ detecciones: 12 }));
      expect(await fallo(conHistorial.casos.eliminar(3, ADMIN))).toEqual({
        tipo: 'conflicto',
        mensaje: 'La cámara tiene 12 detecciones registradas: deshabilítela en lugar de eliminarla para conservar el historial.',
      });
      expect(conHistorial.repositorio.eliminar).not.toHaveBeenCalled();

      const { casos, repositorio, auditoria, eventos, video, motor } = preparar();
      await casos.eliminar(3, ADMIN);
      expect(repositorio.eliminar).toHaveBeenCalledWith(3);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_ELIMINADA', 'camara', 3, 'Garita norte');
      expect(eventos.emitir).toHaveBeenCalledWith('camara:eliminada', { id: 3 });
      await enCola();
      expect(video.sincronizarRutas).toHaveBeenCalled();
      expect(motor.sincronizar).toHaveBeenCalled();
      expect(await fallo(preparar(null).casos.eliminar(99, ADMIN))).toEqual(NO_ENCONTRADA);
    });
  });

  describe('diagnóstico', () => {
    it('probar: con camara_id y la URL enmascarada se diagnostica con la contraseña guardada', async () => {
      const { casos, repositorio, conectividad } = preparar();
      expect(await casos.probar({ rtsp_url: URL_ENMASCARADA, camara_id: 3 })).toBe(DIAGNOSTICO);
      expect(repositorio.conexion).toHaveBeenCalledWith(3);
      expect(conectividad.diagnosticar).toHaveBeenCalledWith(URL_GUARDADA, null);
    });

    it('probar: sin máscara no consulta la base; IP, cámara o URL inválidas → 400 sin diagnosticar', async () => {
      const { casos, repositorio, conectividad } = preparar();
      await casos.probar({ rtsp_url: 'rtsp://192.168.1.70/live', ip: '192.168.1.70', camara_id: 3 });
      expect(repositorio.conexion).not.toHaveBeenCalled();
      expect(conectividad.diagnosticar).toHaveBeenCalledWith('rtsp://192.168.1.70/live', '192.168.1.70');
      for (const entrada of [
        { rtsp_url: URL_ENMASCARADA, camara_id: 'abc' },
        { rtsp_url: URL_ENMASCARADA, camara_id: 0 },
        { rtsp_url: 'http://192.168.1.70/live' },
        { rtsp_url: 'rtsp://192.168.1.70/live', ip: '192.168.1.300' },
      ]) expect((await fallo(casos.probar(entrada))).tipo).toBe('validacion');
      expect(conectividad.diagnosticar).toHaveBeenCalledTimes(1);
    });

    it('diagnosticar: guarda el resultado y avisa aunque no cambie el estado; 404 si no existe', async () => {
      const { casos, conectividad } = preparar();
      expect(await casos.diagnosticar(3)).toBe(DIAGNOSTICO);
      expect(conectividad.diagnosticar).toHaveBeenCalledWith(URL_GUARDADA, '192.168.1.64');
      expect(conectividad.registrar).toHaveBeenCalledWith(3, RTSP_OK, true);
      expect(await fallo(preparar(null).casos.diagnosticar(99))).toEqual(NO_ENCONTRADA);
    });

    it('diagnosticarTodas: resume las cámaras habilitadas en línea', async () => {
      const { casos, repositorio, conectividad } = preparar();
      repositorio.habilitadas.mockResolvedValue([
        { id: 1, nombre: 'Garita norte', ip: '192.168.1.64', rtsp_url: 'rtsp://192.168.1.64/a' },
        { id: 2, nombre: 'Garita sur', ip: '192.168.1.65', rtsp_url: 'rtsp://192.168.1.65/b' },
      ]);
      conectividad.diagnosticar
        .mockResolvedValueOnce(DIAGNOSTICO)
        .mockResolvedValueOnce({ ping: null, rtsp: { ...RTSP_OK, en_linea: false, diagnostico: 'sin_respuesta', mensaje: 'Sin respuesta' } });
      const r = await casos.diagnosticarTodas();
      expect(r).toMatchObject({ total: 2, en_linea: 1 });
      expect(r.detalles.map(x => [x.id, x.nombre, x.rtsp.en_linea])).toEqual([[1, 'Garita norte', true], [2, 'Garita sur', false]]);
      expect(conectividad.registrar).toHaveBeenCalledTimes(2);
    });
  });

  describe('video', () => {
    it('video: cámara habilitada → ruta cam_<id>, ticket de video y URL WebRTC; 409 deshabilitada; 404', async () => {
      const { casos, video, tickets } = preparar();
      expect(await casos.video(3, ADMIN)).toEqual({ ruta: 'cam_3', ruta_vista: null, ticket: 'ticket-1-stream', webrtc: 'https://video.ecu911.local' });
      expect(video.sincronizarRutas).toHaveBeenCalled();
      expect(tickets.emitir).toHaveBeenCalledWith(1, 'stream');
      expect(await fallo(preparar(guardada({ activa: false })).casos.video(3, ADMIN)))
        .toEqual({ tipo: 'conflicto', mensaje: 'Habilite la cámara para reproducir su video.' });
      expect(await fallo(preparar(null).casos.video(99, ADMIN))).toEqual(NO_ENCONTRADA);
    });

    it('pruebaVideo: ruta temporal con la contraseña guardada; URL inválida → 400 sin crear la ruta', async () => {
      const { casos, video } = preparar();
      expect(await casos.pruebaVideo({ rtsp_url: URL_ENMASCARADA, camara_id: 3 }, ADMIN))
        .toEqual({ ruta: 'prueba_0123456789ab', ticket: 'ticket-1-stream', webrtc: 'https://video.ecu911.local' });
      expect(video.crearRutaPrueba).toHaveBeenCalledWith(URL_GUARDADA);
      // El motivo concreto, como en probar (p. ej. que hay que volver a escribir la contraseña)
      for (const [rtsp_url, mensaje] of [
        ['', 'El campo «URL RTSP» es obligatorio.'],
        ['http://192.168.1.64/live', 'Ingrese una URL RTSP válida (rtsp://…).'],
        ['rtsp://:554/live', 'URL RTSP inválida.'],
      ]) {
        expect(await fallo(casos.pruebaVideo({ rtsp_url }, ADMIN))).toEqual({ tipo: 'validacion', mensaje });
      }
      expect((await fallo(casos.pruebaVideo({ rtsp_url: URL_ENMASCARADA, camara_id: -3 }, ADMIN))).tipo).toBe('validacion');
      expect(video.crearRutaPrueba).toHaveBeenCalledTimes(1);
    });

    it('estado del flujo: solo rutas cam_<id> o prueba_<hex>; sin respuesta del servidor → fuente no lista', async () => {
      const { casos, video } = preparar();
      expect(await casos.estadoVideo('cam_3')).toEqual({ lista: false, lectores: 0, pistas: [] });
      video.estadoRuta.mockResolvedValueOnce({ lista: true, lectores: 2, pistas: ['H264'] });
      expect(await casos.estadoVideo('prueba_0123456789ab')).toEqual({ lista: true, lectores: 2, pistas: ['H264'] });
      for (const ruta of ['cam_x', '..%2Fconfig', 'prueba_XYZ', 'cam_3/../otra']) {
        expect(await fallo(casos.estadoVideo(ruta))).toEqual({ tipo: 'validacion', mensaje: 'Ruta inválida.' });
      }
      expect(video.estadoRuta).toHaveBeenCalledTimes(2);
    });

    it('eliminar la prueba de video nunca elimina la ruta de una cámara registrada', async () => {
      const { casos, video } = preparar();
      await casos.eliminarPruebaVideo('cam_3');
      expect(video.eliminarRutaPrueba).not.toHaveBeenCalled();
      await casos.eliminarPruebaVideo('prueba_0123456789ab');
      expect(video.eliminarRutaPrueba).toHaveBeenCalledWith('prueba_0123456789ab');
    });
  });
});

describe('Casos de uso · cámaras · la contraseña guardada no viaja a otro equipo', () => {
  // La máscara con otro host: alguien con acceso al formulario podría apuntar la cámara a un equipo
  // propio que pida autenticación Basic y así leer la contraseña custodiada
  const OTRO_EQUIPO = 'rtsp://admin:******@192.168.1.99:554/Streaming/Channels/101';

  it('probar, prueba de video y editar → 400 sin diagnosticar, publicar ni guardar', async () => {
    const { casos, conectividad, video, repositorio } = preparar();
    for (const intento of [
      () => casos.probar({ rtsp_url: OTRO_EQUIPO, camara_id: 3 }),
      () => casos.pruebaVideo({ rtsp_url: OTRO_EQUIPO, camara_id: 3 }, ADMIN),
      () => casos.editar(3, { ...VALIDA, rtsp_url: OTRO_EQUIPO }, ADMIN),
    ]) {
      expect(await fallo(intento())).toEqual({ tipo: 'validacion', mensaje: expect.stringContaining('escriba de nuevo la contraseña') });
    }
    expect(conectividad.diagnosticar).not.toHaveBeenCalled();
    expect(conectividad.probar).not.toHaveBeenCalled();
    expect(video.crearRutaPrueba).not.toHaveBeenCalled();
    expect(repositorio.actualizar).not.toHaveBeenCalled();
  });
});

describe('Casos de uso · cámaras · credenciales protegidas y flujo de vista', () => {
  const VISTA = `rtsp://admin:${CLAVE}@192.168.1.64:554/Streaming/Channels/102`;
  const VISTA_ENMASCARADA = 'rtsp://admin:******@192.168.1.64:554/Streaming/Channels/102';
  // Reemplazo con función: la contraseña contiene «$&», que en un texto de reemplazo insertaría lo encontrado
  const protegida = (url: string) => url.replace(`:${CLAVE}@`, () => `:P(${CLAVE})@`);

  it('al registrar se protegen las contraseñas de ambos flujos; la verificación usa la URL revelada', async () => {
    const { casos, repositorio, conectividad, video } = preparar(guardada(), custodiaMarcada());
    await casos.registrar({ ...VALIDA, rtsp_url_vista: VISTA }, ADMIN);
    expect(repositorio.crear).toHaveBeenCalledWith(expect.objectContaining({ rtsp: protegida(URL_GUARDADA), rtspVista: protegida(VISTA) }), 1);
    await enCola();
    expect(conectividad.probar).toHaveBeenCalledWith(URL_GUARDADA, '192.168.1.64');
    expect(video.sincronizarRutas).toHaveBeenCalled();
  });

  it('editar con la contraseña enmascarada conserva la protegida tal cual (no se vuelve a cifrar ni cuenta como cambio)', async () => {
    const { casos, repositorio, auditoria } = preparar(guardada({ rtsp_url: protegida(URL_GUARDADA) }), custodiaMarcada());
    await casos.editar(3, { ...VALIDA, rtsp_url: URL_ENMASCARADA }, ADMIN);
    expect(repositorio.actualizar).toHaveBeenCalledWith(3, expect.objectContaining({ rtsp: protegida(URL_GUARDADA) }));
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_EDICION', 'camara', 3, 'Garita norte: sin cambios');
  });

  it('agregar la vista enmascarada a una cámara que no la tenía reutiliza la contraseña del flujo principal', async () => {
    const { casos, repositorio, video } = preparar(guardada({ rtsp_url: protegida(URL_GUARDADA) }), custodiaMarcada());
    await casos.editar(3, { ...VALIDA, rtsp_url: URL_ENMASCARADA, rtsp_url_vista: VISTA_ENMASCARADA }, ADMIN);
    expect(repositorio.actualizar).toHaveBeenCalledWith(3, expect.objectContaining({ rtspVista: protegida(VISTA) }));
    await enCola();
    expect(video.sincronizarRutas).toHaveBeenCalled();
  });

  it('el diagnóstico y la ruta de prueba reciben la contraseña revelada', async () => {
    const { casos, conectividad, video } = preparar(guardada({ rtsp_url: protegida(URL_GUARDADA), rtsp_url_vista: protegida(VISTA) }),
      custodiaMarcada());
    await casos.probar({ rtsp_url: URL_ENMASCARADA, camara_id: 3 });
    expect(conectividad.diagnosticar).toHaveBeenLastCalledWith(URL_GUARDADA, null);
    await casos.diagnosticar(3);
    expect(conectividad.diagnosticar).toHaveBeenLastCalledWith(URL_GUARDADA, '192.168.1.64');
    await casos.pruebaVideo({ rtsp_url: VISTA_ENMASCARADA, camara_id: 3, vista: true }, ADMIN);
    expect(video.crearRutaPrueba).toHaveBeenCalledWith(VISTA);
  });

  it('el largo máximo se mide sobre la contraseña en claro, no sobre la cifrada', async () => {
    // URL de 255 caracteres: protegida («P(…)») supera el límite, en claro no
    const larga = `rtsp://admin:${'k'.repeat(255 - 'rtsp://admin:@192.168.1.64:554/Streaming/Channels/101'.length)}@192.168.1.64:554/Streaming/Channels/101`;
    const cifrada = custodiaMarcada().proteger(larga);
    expect(larga).toHaveLength(255);
    expect(cifrada.length).toBeGreaterThan(255);
    const { casos, repositorio, video } = preparar(guardada({ rtsp_url: cifrada }), custodiaMarcada());
    await casos.editar(3, { ...VALIDA, rtsp_url: URL_ENMASCARADA }, ADMIN);
    expect(repositorio.actualizar).toHaveBeenCalledWith(3, expect.objectContaining({ rtsp: cifrada }));
    await casos.pruebaVideo({ rtsp_url: URL_ENMASCARADA, camara_id: 3 }, ADMIN);
    expect(video.crearRutaPrueba).toHaveBeenCalledWith(larga);
  });

  it('el Play informa la ruta de vista solo si la cámara tiene flujo de vista', async () => {
    const con = preparar(guardada({ rtsp_url_vista: VISTA }));
    expect(await con.casos.video(3, ADMIN)).toMatchObject({ ruta: 'cam_3', ruta_vista: 'cam_3_vista' });
    expect(await preparar().casos.video(3, ADMIN)).toMatchObject({ ruta: 'cam_3', ruta_vista: null });
    expect(await con.casos.estadoVideo('cam_3_vista')).toEqual({ lista: false, lectores: 0, pistas: [] });
  });
});

describe('Casos de uso · cámaras · redes permitidas (protección contra SSRF)', () => {
  const FUERA = 'La dirección 8.8.8.8 está fuera de las redes permitidas para cámaras (CAMARAS_REDES_PERMITIDAS).';
  const URL_INTERNET = 'rtsp://admin:clave@8.8.8.8:554/Streaming/Channels/101';

  it('alta y edición: una cámara fuera de las redes permitidas se rechaza sin guardar ni conectar', async () => {
    const { casos, repositorio, conectividad, video } = preparar();
    conectividad.verificarRed.mockResolvedValue(FUERA);
    expect(await fallo(casos.registrar({ ...VALIDA, rtsp_url: URL_INTERNET }, ADMIN))).toEqual({ tipo: 'validacion', mensaje: FUERA });
    expect(await fallo(casos.editar(3, { ...VALIDA, rtsp_url: URL_INTERNET }, ADMIN))).toEqual({ tipo: 'validacion', mensaje: FUERA });
    expect(repositorio.crear).not.toHaveBeenCalled();
    expect(repositorio.actualizar).not.toHaveBeenCalled();
    expect(video.sincronizarRutas).not.toHaveBeenCalled();
  });

  it('también se comprueba el flujo de vista', async () => {
    const { casos, repositorio, conectividad } = preparar();
    conectividad.verificarRed.mockImplementation(async (url: string) => (url.includes('8.8.8.8') ? FUERA : null));
    const vista = { ...VALIDA, rtsp_url_vista: 'rtsp://admin:clave@8.8.8.8:554/Streaming/Channels/102' };
    expect(await fallo(casos.registrar(vista, ADMIN))).toEqual({ tipo: 'validacion', mensaje: FUERA });
    expect(repositorio.crear).not.toHaveBeenCalled();
  });

  it('Ping y Play de prueba: no se conecta a destinos fuera de las redes permitidas', async () => {
    const { casos, conectividad, video } = preparar();
    conectividad.verificarRed.mockResolvedValue(FUERA);
    expect(await fallo(casos.probar({ rtsp_url: URL_INTERNET }))).toEqual({ tipo: 'validacion', mensaje: FUERA });
    expect(await fallo(casos.pruebaVideo({ rtsp_url: URL_INTERNET }, ADMIN))).toEqual({ tipo: 'validacion', mensaje: FUERA });
    expect(conectividad.diagnosticar).not.toHaveBeenCalled();
    expect(video.crearRutaPrueba).not.toHaveBeenCalled();
  });

  it('diagnóstico de una cámara guardada que quedó fuera de las redes: se informa y no se conecta', async () => {
    const { casos, conectividad } = preparar();
    conectividad.verificarRed.mockResolvedValue(FUERA);
    const r = await casos.diagnosticar(3);
    expect(r).toEqual({ ping: null, rtsp: expect.objectContaining({ en_linea: false, diagnostico: 'red_no_permitida', mensaje: FUERA }) });
    expect(conectividad.diagnosticar).not.toHaveBeenCalled();
    expect(conectividad.registrar).toHaveBeenCalledWith(3, r.rtsp, true);
  });
});
