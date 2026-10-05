import {
  casosCamaras, type DiagnosticoCamara, type PuertoConectividad, type PuertoMotorAnpr, type PuertoServidorVideo,
  type PuertoTickets, type RepositorioCamaras, type ResultadoRtsp,
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

function preparar(camara: CamaraGuardada | null = guardada()) {
  const repositorio: jest.Mocked<RepositorioCamaras> = {
    listar: jest.fn().mockResolvedValue(camara ? [camara] : []),
    obtener: jest.fn().mockImplementation(async (id: number) => (camara ? { ...camara, id } : null)),
    conexion: jest.fn().mockResolvedValue(camara
      ? { id: camara.id, nombre: camara.nombre, ip: camara.ip, rtsp_url: camara.rtsp_url, activa: Boolean(camara.activa) }
      : null),
    habilitadas: jest.fn().mockResolvedValue([]),
    crear: jest.fn().mockResolvedValue(7),
    actualizar: jest.fn().mockResolvedValue(undefined),
    alternarActiva: jest.fn().mockResolvedValue(camara ? { nombre: camara.nombre, activa: false } : null),
    fijarRoi: jest.fn().mockResolvedValue(camara ? camara.nombre : null),
    eliminar: jest.fn().mockResolvedValue(undefined),
  };
  const conectividad: jest.Mocked<PuertoConectividad> = {
    destino: jest.fn(destinoDoble),
    probar: jest.fn().mockResolvedValue(RTSP_OK),
    diagnosticar: jest.fn().mockResolvedValue(DIAGNOSTICO),
    registrar: jest.fn().mockResolvedValue(undefined),
  };
  const video: jest.Mocked<PuertoServidorVideo> = {
    rutaCamara: jest.fn((id: number) => `cam_${id}`),
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
    fijarRoi: jest.fn().mockResolvedValue({}),
    sincronizar: jest.fn().mockResolvedValue(false),
    urlPublica: jest.fn(() => 'https://anpr.ecu911.local'),
  };
  const auditoria = { operacion: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emitir: jest.fn() };
  const casos = casosCamaras({ repositorio, conectividad, video, tickets, motor, auditoria, eventos });
  return { casos, repositorio, conectividad, video, tickets, motor, auditoria, eventos };
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
        { nombre: 'Garita sur', ubicacion: 'Acceso sur, bloque B', rtsp: URL_GUARDADA, ip: '192.168.1.64' }, 1);
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
        { nombre: 'Garita norte 2', ubicacion: 'Acceso vehicular norte', rtsp: URL_GUARDADA, ip: '192.168.1.64' });
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
        { nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', rtsp: nueva, ip: '192.168.1.65' });
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
    ])('fijarRoi: rechaza %s sin tocar la base', async (_caso, roi, mensaje) => {
      const { casos, repositorio, motor } = preparar();
      expect(await fallo(casos.fijarRoi(3, roi, ADMIN))).toEqual({ tipo: 'validacion', mensaje });
      expect(repositorio.fijarRoi).not.toHaveBeenCalled();
      expect(motor.fijarRoi).not.toHaveBeenCalled();
    });

    it('fijarRoi: guarda la región redondeada, audita y la aplica en el motor; null vuelve al cuadro completo', async () => {
      const { casos, repositorio, auditoria, motor } = preparar();
      const r = await casos.fijarRoi(3, [[0.123456, 0.2], [0.9, 0.2], [0.5, 0.95]], ADMIN);
      expect(r.roi).toEqual([[0.1235, 0.2], [0.9, 0.2], [0.5, 0.95]]);
      expect(repositorio.fijarRoi).toHaveBeenCalledWith(3, r.roi);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: región de 3 vértices');
      await enCola();
      expect(motor.fijarRoi).toHaveBeenCalledWith(3, r.roi);

      expect((await casos.fijarRoi(3, null, ADMIN)).roi).toBeNull();
      expect((await casos.fijarRoi(3, [], ADMIN)).roi).toBeNull();
      expect(auditoria.operacion).toHaveBeenLastCalledWith(ADMIN, 'CAMARA_ROI', 'camara', 3, 'Garita norte: cuadro completo');
      expect(await fallo(preparar(null).casos.fijarRoi(99, null, ADMIN))).toEqual(NO_ENCONTRADA);
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
      expect(await casos.video(3, ADMIN)).toEqual({ ruta: 'cam_3', ticket: 'ticket-1-stream', webrtc: 'https://video.ecu911.local' });
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
      for (const rtsp_url of ['', 'http://192.168.1.64/live', 'rtsp://:554/live']) {
        expect(await fallo(casos.pruebaVideo({ rtsp_url }, ADMIN))).toEqual({ tipo: 'validacion', mensaje: 'URL RTSP inválida.' });
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
