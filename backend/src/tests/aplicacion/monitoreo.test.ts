import type { ConexionCamara, EstadoMotor, PuertoMotorAnpr } from '../../aplicacion/camaras';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import { casosMonitoreo } from '../../aplicacion/monitoreo';
import type { AlcanceTicket } from '../../dominio/camaras';

/** Casos de uso del monitoreo en vivo con dobles de prueba: sin base de datos, sin MediaMTX ni motor ANPR. */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administrador', rol: 'Admin', ip: '10.0.0.1' };
const GUARDIA: Actor = { id: 3, email: 'guardia@ecu911.gob.ec', nombre: 'Guardia de garita', rol: 'Guardia', ip: '10.0.0.3' };

const CAMARA: ConexionCamara = { id: 3, nombre: 'Garita norte', ip: '192.168.1.64', rtsp_url: 'rtsp://admin:clave@192.168.1.64/101', activa: true };
const EN_LINEA: EstadoMotor = {
  en_linea: true, fps_captura: 25, fps_procesamiento: 12, detector: 'YOLO26n', ocr: 'PaddleOCR', camara_activa: { id: 3, conectada: true },
};

function preparar(camara: ConexionCamara | null = CAMARA) {
  const motor: jest.Mocked<PuertoMotorAnpr> = {
    estado: jest.fn().mockResolvedValue({ en_linea: false, error: 'Sin respuesta' }),
    camaraDeseada: jest.fn().mockResolvedValue(null),
    procesa: jest.fn().mockResolvedValue(false),
    guardarCamara: jest.fn().mockResolvedValue(undefined),
    cambiarCamara: jest.fn().mockResolvedValue({}),
    fijarRoi: jest.fn().mockResolvedValue({}),
    sincronizar: jest.fn().mockResolvedValue(false),
    urlPublica: jest.fn(() => 'https://anpr.ecu911.local'),
  };
  const dependencias = {
    repositorio: { conexion: jest.fn().mockResolvedValue(camara) },
    motor,
    video: {
      rutaCamara: jest.fn((id: number) => `cam_${id}`),
      urlLecturaMotor: jest.fn((ruta: string) => `rtsp://anpr:token@mediamtx:8554/${ruta}`),
      urlWebrtc: jest.fn(() => 'https://video.ecu911.local'),
      sincronizarRutas: jest.fn().mockResolvedValue(undefined),
    },
    tickets: { emitir: jest.fn((usuarioId: number, alcance: AlcanceTicket) => `ticket-${usuarioId}-${alcance}`) },
    auditoria: { operacion: jest.fn().mockResolvedValue(undefined) },
    eventos: { emitir: jest.fn() },
  };
  return { casos: casosMonitoreo(dependencias), ...dependencias };
}

/** Tipo y mensaje del ErrorAplicacion (cualquier otro error hace fallar la prueba). */
const comoError = (e: unknown) => {
  if (e instanceof ErrorAplicacion) return { tipo: e.tipo, mensaje: e.message };
  throw e;
};
const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return comoError(e); }
  throw new Error('se esperaba un error');
};
const falloSincrono = (fn: () => unknown) => {
  try { fn(); } catch (e) { return comoError(e); }
  throw new Error('se esperaba un error');
};

describe('Casos de uso · monitoreo', () => {
  describe('estado', () => {
    it('motor fuera de línea: se informa tal cual, sin consultar la cámara deseada', async () => {
      const { casos, motor } = preparar();
      expect(await casos.estado()).toEqual({ en_linea: false, error: 'Sin respuesta' });
      expect(motor.camaraDeseada).not.toHaveBeenCalled();
    });

    it('el motor procesa la ruta de la cámara deseada → cámara activa y fuente propia', async () => {
      const { casos, motor } = preparar();
      motor.estado.mockResolvedValue(EN_LINEA);
      motor.camaraDeseada.mockResolvedValue({ id: 3 });
      motor.procesa.mockResolvedValue(true);
      expect(await casos.estado()).toEqual({ ...EN_LINEA, camara_activa: { id: 3, conectada: true }, fuente_externa: false });
      expect(motor.procesa).toHaveBeenCalledWith({ id: 3 });
    });

    it('el motor procesa otra fuente, o falla la consulta → sin cámara activa y fuente externa', async () => {
      const { casos, motor } = preparar();
      motor.estado.mockResolvedValue(EN_LINEA);
      motor.camaraDeseada.mockResolvedValue({ id: 3 });
      expect(await casos.estado()).toMatchObject({ en_linea: true, camara_activa: null, fuente_externa: true });
      // Una falla al consultar la cámara deseada no tumba el estado del monitoreo
      motor.camaraDeseada.mockRejectedValue(new Error('base no disponible'));
      motor.procesa.mockRejectedValue(new Error('motor no responde'));
      expect(await casos.estado()).toMatchObject({ en_linea: true, camara_activa: null, fuente_externa: true });
    });
  });

  describe('cambiar la cámara que procesa el motor', () => {
    it.each([undefined, null, '', 0, -2, 1.5, 'abc', '3a', true, 2147483648])('camara_id %p → 400 sin consultar la base', async id => {
      const { casos, repositorio, motor } = preparar();
      expect(await fallo(casos.cambiarCamara(id, ADMIN))).toEqual({ tipo: 'validacion', mensaje: 'Seleccione una cámara.' });
      expect(repositorio.conexion).not.toHaveBeenCalled();
      expect(motor.cambiarCamara).not.toHaveBeenCalled();
    });

    it('404 si no existe y 409 si está deshabilitada, sin tocar el motor', async () => {
      expect(await fallo(preparar(null).casos.cambiarCamara(99, ADMIN))).toEqual({ tipo: 'no_encontrado', mensaje: 'Cámara no encontrada.' });
      const { casos, motor } = preparar({ ...CAMARA, activa: false });
      expect(await fallo(casos.cambiarCamara(3, ADMIN))).toEqual({ tipo: 'conflicto', mensaje: 'La cámara está deshabilitada.' });
      expect(motor.guardarCamara).not.toHaveBeenCalled();
      expect(motor.cambiarCamara).not.toHaveBeenCalled();
    });

    it('recuerda la elección, publica la ruta y el motor la lee desde MediaMTX; audita y difunde', async () => {
      const { casos, repositorio, motor, video, auditoria, eventos } = preparar();
      expect(await casos.cambiarCamara('3', ADMIN)).toEqual({ id: 3, nombre: 'Garita norte' });
      expect(repositorio.conexion).toHaveBeenCalledWith(3);
      expect(motor.guardarCamara).toHaveBeenCalledWith(3, 1);
      // El motor nunca recibe la URL de la cámara (con su contraseña), sino su ruta en MediaMTX
      expect(motor.cambiarCamara).toHaveBeenCalledWith({ id: 3, nombre: 'Garita norte', rtsp_url: 'rtsp://anpr:token@mediamtx:8554/cam_3' }, true);
      expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'MONITOREO_CAMARA', 'camara', 3, 'Motor ANPR procesando Garita norte');
      expect(eventos.emitir).toHaveBeenCalledWith('monitoreo:camara', { camara_id: 3, nombre: 'Garita norte', por: 'Administrador' });
      // La ruta se publica en MediaMTX antes de pedir al motor que la lea
      const orden = [motor.guardarCamara, video.sincronizarRutas, motor.cambiarCamara, auditoria.operacion]
        .map(f => f.mock.invocationCallOrder[0]);
      expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    });

    it('si el motor no responde, el error se propaga (502 en la API) y no se audita un cambio que no ocurrió', async () => {
      const { casos, motor, auditoria, eventos } = preparar();
      motor.cambiarCamara.mockRejectedValue(new Error('HTTP 503'));
      await expect(casos.cambiarCamara(3, ADMIN)).rejects.toThrow('HTTP 503');
      expect(auditoria.operacion).not.toHaveBeenCalled();
      expect(eventos.emitir).not.toHaveBeenCalled();
    });
  });

  describe('ticket de video', () => {
    it('por omisión stream, para cualquier rol con monitoreo', () => {
      const { casos, tickets } = preparar();
      expect(casos.ticket(undefined, GUARDIA)).toEqual({ ticket: 'ticket-3-stream', url: 'https://anpr.ecu911.local', webrtc: 'https://video.ecu911.local' });
      expect(casos.ticket('stream', GUARDIA).ticket).toBe('ticket-3-stream');
      expect(tickets.emitir).toHaveBeenCalledWith(3, 'stream');
    });

    it('webcam (enviar la webcam del navegador al motor): solo con camaras:gestionar', () => {
      const { casos, tickets } = preparar();
      expect(casos.ticket('webcam', ADMIN).ticket).toBe('ticket-1-webcam');
      expect(falloSincrono(() => casos.ticket('webcam', GUARDIA)))
        .toEqual({ tipo: 'prohibido', mensaje: 'Solo el administrador puede usar la webcam como fuente de prueba.' });
      expect(tickets.emitir).toHaveBeenCalledTimes(1);
    });

    it.each(['WEBCAM', ' webcam', 'video', 5, {}])('alcance %p fuera de los valores permitidos → 400', alcance => {
      const { casos, tickets } = preparar();
      expect(falloSincrono(() => casos.ticket(alcance, ADMIN))).toEqual({ tipo: 'validacion', mensaje: 'Alcance inválido. Valores: stream, webcam.' });
      expect(tickets.emitir).not.toHaveBeenCalled();
    });
  });
});
