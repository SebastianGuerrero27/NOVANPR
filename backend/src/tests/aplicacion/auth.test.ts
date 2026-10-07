import {
  casosAuth, type CuentaAcceso, type EnlaceGuardado, RechazoAutenticacion, type RepositorioAuth,
} from '../../aplicacion/auth';
import { type Actor, ErrorAplicacion } from '../../aplicacion/comun';
import type { Visitante } from '../../aplicacion/usuarios';

/** Casos de uso de la autenticación con dobles de prueba: sin base de datos, sin bcrypt, sin correo. */

const VISITANTE: Visitante = { ip: '10.0.0.9', agente: 'jest' };
const GUARDIA: Actor = { id: 7, email: 'guardia@ecu911.gob.ec', nombre: 'Luis Mendoza', rol: 'Guardia', ip: '10.0.0.7' };
const CLAVE = 'ClaveSegura#2026';
const NUEVA = 'Nueva#Clave2026';
const TOKEN = 'a'.repeat(64);

const cuenta = (parcial: Partial<CuentaAcceso> = {}): CuentaAcceso => ({
  id: 7, email: 'guardia@ecu911.gob.ec', nombre_completo: 'Luis Mendoza', cargo: null, password_hash: `bcrypt(${CLAVE})`,
  rol: 'Guardia', estado: 'activo', email_verificado: true, bloqueado: false, bloqueado_hasta: null, intentos_fallidos: 0,
  ...parcial,
});

const enlace = (parcial: Partial<EnlaceGuardado> = {}): EnlaceGuardado => ({
  id: 31, usuario_id: 7, usado: false, fecha_expiracion: new Date(Date.now() + 60 * 60000),
  email: 'guardia@ecu911.gob.ec', nombre_completo: 'Luis Mendoza', ...parcial,
});

function preparar(guardada: CuentaAcceso | null = cuenta()) {
  const repositorio: jest.Mocked<RepositorioAuth> = {
    hayAdministrador: jest.fn().mockResolvedValue(true),
    porEmail: jest.fn().mockResolvedValue(guardada),
    sesion: jest.fn().mockResolvedValue(null),
    credenciales: jest.fn().mockResolvedValue({ id: 7, email: 'guardia@ecu911.gob.ec', nombre_completo: 'Luis Mendoza', password_hash: `bcrypt(${CLAVE})` }),
    crearPrimerAdministrador: jest.fn().mockResolvedValue(true),
    registrar: jest.fn().mockResolvedValue(21),
    registrarIntentoFallido: jest.fn().mockResolvedValue(undefined),
    registrarAcceso: jest.fn().mockResolvedValue(undefined),
    actualizarPerfil: jest.fn().mockResolvedValue(undefined),
    cambiarPassword: jest.fn().mockResolvedValue(undefined),
    enlaceReciente: jest.fn().mockResolvedValue(false),
    emitirEnlace: jest.fn().mockResolvedValue(undefined),
    buscarEnlace: jest.fn().mockResolvedValue(null),
    confirmarCorreo: jest.fn().mockResolvedValue(undefined),
    restablecerPassword: jest.fn().mockResolvedValue(undefined),
  };
  const auditoria = { cuenta: jest.fn().mockResolvedValue(undefined), acceso: jest.fn().mockResolvedValue(undefined) };
  const correo = {
    smtpConfigurado: jest.fn().mockReturnValue(true),
    verificacionCuenta: jest.fn().mockResolvedValue(true),
    restablecerPassword: jest.fn().mockResolvedValue(true),
    definirPasswordCuentaNueva: jest.fn().mockResolvedValue(true),
    passwordCambiada: jest.fn().mockResolvedValue(true),
    cuentaBloqueada: jest.fn().mockResolvedValue(true),
  };
  const tokens = { generar: jest.fn().mockReturnValue({ token: 'b'.repeat(64), hash: 'h'.repeat(64) }), hash: jest.fn((t: string) => `sha256(${t})`) };
  const claves = {
    cifrar: jest.fn(async (p: string) => `bcrypt(${p})`),
    comparar: jest.fn(async (p: string, h: string) => h === `bcrypt(${p})`),
    compararFicticio: jest.fn().mockResolvedValue(undefined),
    inutilizable: jest.fn().mockResolvedValue('$2a$10$inutilizable'),
  };
  const sesiones = { firmar: jest.fn().mockReturnValue('jwt.firmado') };
  const parametros = {
    registroHabilitado: jest.fn().mockReturnValue(true),
    dominiosPermitidos: jest.fn().mockReturnValue(['ecu911.gob.ec']),
    unidadInstitucional: jest.fn().mockReturnValue('ECU 911 Zonal 8'),
    maxIntentos: jest.fn().mockReturnValue(5),
    minutosBloqueo: jest.fn().mockReturnValue(15),
  };
  const registrarFallo = jest.fn();
  const casos = casosAuth({
    repositorio, auditoria, correo, tokens, claves, sesiones, parametros, registrarFallo, urlFrontend: () => 'https://anpr.ecu911.gob.ec',
  });
  return { casos, repositorio, auditoria, correo, tokens, claves, sesiones, parametros, registrarFallo };
}

/** Error con el que falla la promesa (ErrorAplicacion o RechazoAutenticacion). */
const fallo = async (p: Promise<unknown>): Promise<ErrorAplicacion & RechazoAutenticacion> => {
  try { await p; } catch (e) { return e as ErrorAplicacion & RechazoAutenticacion; }
  throw new Error('se esperaba un error');
};

describe('Casos de uso · autenticación', () => {
  it('estado: datos públicos para la pantalla de acceso', async () => {
    const { casos, repositorio } = preparar();
    repositorio.hayAdministrador.mockResolvedValue(false);
    expect(await casos.estado()).toEqual({
      configuracion_inicial_requerida: true, registro_habilitado: true, smtp_configurado: true,
      dominios_permitidos: ['ecu911.gob.ec'], unidad_institucional: 'ECU 911 Zonal 8',
    });
  });

  describe('configuración inicial', () => {
    const DATOS = { nombre_completo: 'María Torres', email: 'Admin@ECU911.gob.ec', password: CLAVE };
    const ADMIN = cuenta({ id: 1, email: 'admin@ecu911.gob.ec', nombre_completo: 'María Torres', rol: 'Admin' });

    it('crea el primer administrador, audita sin actor y devuelve la sesión iniciada', async () => {
      const { casos, repositorio, auditoria, sesiones } = preparar(ADMIN);
      repositorio.hayAdministrador.mockResolvedValue(false);
      const s = await casos.configuracionInicial(DATOS, VISITANTE);
      expect(repositorio.crearPrimerAdministrador).toHaveBeenCalledWith({
        email: 'admin@ecu911.gob.ec', nombre_completo: 'María Torres', cargo: null, passwordHash: `bcrypt(${CLAVE})`,
      });
      expect(auditoria.cuenta).toHaveBeenCalledWith(VISITANTE, 'CONFIGURACION_INICIAL', { id: 1, email: 'admin@ecu911.gob.ec' }, 'Primer administrador del sistema');
      expect(sesiones.firmar).toHaveBeenCalledWith({ id: 1, email: 'admin@ecu911.gob.ec', nombre: 'María Torres', rol: 'Admin' });
      expect(s.token).toBe('jwt.firmado');
      expect(s.user).toMatchObject({ id: 1, username: 'admin@ecu911.gob.ec', rol: 'Admin', rol_nombre: 'Administrador' });
      expect(s.user.permisos).toContain('usuarios:gestionar');
    });

    it('409 si ya existe un administrador (sin cifrar la contraseña) o si otra solicitud lo creó antes', async () => {
      const ya = preparar(ADMIN);
      const e1 = await fallo(ya.casos.configuracionInicial(DATOS, VISITANTE));
      expect([e1.tipo, e1.message]).toEqual(['conflicto', 'El sistema ya tiene un administrador. Inicie sesión.']);
      expect(ya.claves.cifrar).not.toHaveBeenCalled();
      const carrera = preparar(ADMIN);
      carrera.repositorio.hayAdministrador.mockResolvedValue(false);
      carrera.repositorio.crearPrimerAdministrador.mockResolvedValue(false);
      expect((await fallo(carrera.casos.configuracionInicial(DATOS, VISITANTE))).tipo).toBe('conflicto');
      expect(carrera.auditoria.cuenta).not.toHaveBeenCalled();
    });

    it('valida nombre, correo y contraseña antes de tocar la base', async () => {
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.configuracionInicial({ ...DATOS, nombre_completo: 'María 2' }, VISITANTE))).tipo).toBe('validacion');
      expect((await fallo(casos.configuracionInicial({ ...DATOS, email: 'admin@gmail.com' }, VISITANTE))).message)
        .toBe('Solo se aceptan correos de: @ecu911.gob.ec.');
      expect((await fallo(casos.configuracionInicial({ ...DATOS, password: 'corta' }, VISITANTE))).message)
        .toBe('La contraseña debe tener al menos 10 caracteres.');
      expect(repositorio.hayAdministrador).not.toHaveBeenCalled();
    });
  });

  describe('inicio de sesión', () => {
    it('exige correo y contraseña', async () => {
      const { casos, repositorio } = preparar();
      const e = await fallo(casos.login({ email: 'guardia@ecu911.gob.ec' }, VISITANTE));
      expect([e.tipo, e.message]).toEqual(['validacion', 'Ingrese su correo y contraseña.']);
      expect(repositorio.porEmail).not.toHaveBeenCalled();
    });

    it('correo normalizado (también como `username`): reinicia los intentos, audita "ok" y entrega rol y permisos', async () => {
      const { casos, repositorio, auditoria, sesiones } = preparar();
      const s = await casos.login({ username: '  GUARDIA@ecu911.gob.ec ', password: CLAVE }, VISITANTE);
      expect(repositorio.porEmail).toHaveBeenCalledWith('guardia@ecu911.gob.ec');
      expect(repositorio.registrarAcceso).toHaveBeenCalledWith(7);
      expect(auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, true, 'ok');
      expect(sesiones.firmar).toHaveBeenCalledWith({ id: 7, email: 'guardia@ecu911.gob.ec', nombre: 'Luis Mendoza', rol: 'Guardia' });
      expect(s).toEqual({
        token: 'jwt.firmado',
        user: {
          id: 7, email: 'guardia@ecu911.gob.ec', username: 'guardia@ecu911.gob.ec', nombre: 'Luis Mendoza', cargo: null,
          rol: 'Guardia', rol_nombre: 'Guardia', permisos: expect.arrayContaining(['operacion:monitorear', 'avisos:garita']),
        },
      });
    });

    it('correo inexistente: mismo costo (hash ficticio), mismo mensaje y acceso fallido sin usuario', async () => {
      const { casos, claves, auditoria } = preparar(null);
      const e = await fallo(casos.login({ email: 'nadie@ecu911.gob.ec', password: CLAVE }, VISITANTE));
      expect(e).toBeInstanceOf(RechazoAutenticacion);
      expect([e.motivo, e.message]).toEqual(['credenciales', 'Correo o contraseña incorrectos.']);
      expect(claves.compararFicticio).toHaveBeenCalledWith(CLAVE);
      expect(auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'nadie@ecu911.gob.ec', null, false, 'credenciales');
    });

    it('bloqueo temporal vigente: 423 con los minutos restantes, sin comparar la contraseña', async () => {
      const { casos, claves, auditoria } = preparar(cuenta({ bloqueado_hasta: new Date(Date.now() + 9.5 * 60000) }));
      const e = await fallo(casos.login({ email: 'guardia@ecu911.gob.ec', password: CLAVE }, VISITANTE));
      expect([e.motivo, e.message]).toEqual(['bloqueo_temporal', 'Cuenta bloqueada temporalmente por intentos fallidos. Intente en 10 min.']);
      expect(claves.comparar).not.toHaveBeenCalled();
      expect(auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, false, 'bloqueado');
    });

    it('un bloqueo temporal ya vencido no impide ingresar', async () => {
      const { casos, repositorio } = preparar(cuenta({ bloqueado_hasta: new Date(Date.now() - 60000), intentos_fallidos: 0 }));
      await casos.login({ email: 'guardia@ecu911.gob.ec', password: CLAVE }, VISITANTE);
      expect(repositorio.registrarAcceso).toHaveBeenCalledWith(7);
    });

    it('bloqueo administrativo: 403', async () => {
      const { casos, auditoria } = preparar(cuenta({ bloqueado: true }));
      const e = await fallo(casos.login({ email: 'guardia@ecu911.gob.ec', password: CLAVE }, VISITANTE));
      expect([e.motivo, e.message]).toEqual(['bloqueo_administrativo', 'Cuenta bloqueada por un administrador.']);
      expect(auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, false, 'bloqueado');
    });

    it('contraseña incorrecta: suma el intento sin bloquear ni avisar', async () => {
      const { casos, repositorio, auditoria, correo } = preparar(cuenta({ intentos_fallidos: 2 }));
      const e = await fallo(casos.login({ email: 'guardia@ecu911.gob.ec', password: 'Otra#Clave2026' }, VISITANTE));
      expect([e.motivo, e.message]).toEqual(['credenciales', 'Correo o contraseña incorrectos.']);
      expect(repositorio.registrarIntentoFallido).toHaveBeenCalledWith(7, 3, false, 15);
      expect(auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, false, 'credenciales');
      expect(correo.cuentaBloqueada).not.toHaveBeenCalled();
    });

    it('al llegar al máximo de intentos bloquea, reinicia el contador, avisa al titular y responde 423', async () => {
      const { casos, repositorio, auditoria, correo } = preparar(cuenta({ intentos_fallidos: 4 }));
      const e = await fallo(casos.login({ email: 'guardia@ecu911.gob.ec', password: 'Otra#Clave2026' }, VISITANTE));
      expect([e.motivo, e.message]).toEqual(['bloqueo_temporal', 'Demasiados intentos fallidos. Cuenta bloqueada 15 minutos.']);
      expect(repositorio.registrarIntentoFallido).toHaveBeenCalledWith(7, 0, true, 15);
      expect(auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, false, 'bloqueo_por_intentos');
      expect(correo.cuentaBloqueada).toHaveBeenCalledWith('guardia@ecu911.gob.ec', 'Luis Mendoza', 15);
    });

    it('el estado de la cuenta se revela solo con la contraseña correcta', async () => {
      const pendiente = preparar(cuenta({ estado: 'pendiente', email_verificado: false }));
      const e1 = await fallo(pendiente.casos.login({ email: 'guardia@ecu911.gob.ec', password: CLAVE }, VISITANTE));
      expect([e1.motivo, e1.message, e1.codigo]).toEqual(['no_verificado', 'Debe verificar su correo antes de ingresar.', 'EMAIL_NO_VERIFICADO']);
      expect(pendiente.auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, false, 'no_verificado');

      const inactiva = preparar(cuenta({ estado: 'inactivo' }));
      const e2 = await fallo(inactiva.casos.login({ email: 'guardia@ecu911.gob.ec', password: CLAVE }, VISITANTE));
      expect([e2.motivo, e2.message]).toEqual(['inactiva', 'La cuenta está inactiva. Contacte al administrador.']);
      expect(inactiva.auditoria.acceso).toHaveBeenCalledWith(VISITANTE, 'guardia@ecu911.gob.ec', 7, false, 'inactivo');
      expect(inactiva.repositorio.registrarAcceso).not.toHaveBeenCalled();

      const sinClave = preparar(cuenta({ estado: 'inactivo' }));
      expect((await fallo(sinClave.casos.login({ email: 'guardia@ecu911.gob.ec', password: 'Otra#Clave2026' }, VISITANTE))).motivo).toBe('credenciales');
    });
  });

  describe('registro público', () => {
    const DATOS = { nombre_completo: 'Carlos Andrade', email: 'carlos@ecu911.gob.ec', password: CLAVE, cargo: 'Guardia de garita' };

    it('403 si está deshabilitado', async () => {
      const { casos, parametros, repositorio } = preparar(null);
      parametros.registroHabilitado.mockReturnValue(false);
      const e = await fallo(casos.registrar(DATOS, VISITANTE));
      expect([e.tipo, e.message]).toEqual(['prohibido', 'El registro público está deshabilitado. Solicite su cuenta al administrador.']);
      expect(repositorio.porEmail).not.toHaveBeenCalled();
    });

    it('409 si el correo ya tiene cuenta', async () => {
      const { casos, repositorio } = preparar(cuenta());
      expect((await fallo(casos.registrar(DATOS, VISITANTE))).message).toBe('Ya existe una cuenta con ese correo.');
      expect(repositorio.registrar).not.toHaveBeenCalled();
    });

    it('crea la cuenta pendiente, emite el enlace de 24 h, envía el correo y audita sin actor', async () => {
      const { casos, repositorio, correo, auditoria } = preparar(null);
      expect(await casos.registrar(DATOS, VISITANTE)).toEqual({ enviado: true });
      expect(repositorio.registrar).toHaveBeenCalledWith({
        email: 'carlos@ecu911.gob.ec', nombre_completo: 'Carlos Andrade', cargo: 'Guardia de garita', passwordHash: `bcrypt(${CLAVE})`,
      });
      expect(repositorio.emitirEnlace).toHaveBeenCalledWith('verificacion', 21, 'h'.repeat(64), 24 * 60);
      expect(correo.verificacionCuenta).toHaveBeenCalledWith('carlos@ecu911.gob.ec', 'Carlos Andrade',
        `https://anpr.ecu911.gob.ec/verificar-email?token=${'b'.repeat(64)}`, 24);
      expect(auditoria.cuenta).toHaveBeenCalledWith(VISITANTE, 'REGISTRO', { id: 21, email: 'carlos@ecu911.gob.ec' }, 'Registro público; pendiente de verificación');
    });

    it('si el correo no sale lo informa (la cuenta igual se crea)', async () => {
      const { casos, correo } = preparar(null);
      correo.verificacionCuenta.mockResolvedValue(false);
      expect(await casos.registrar(DATOS, VISITANTE)).toEqual({ enviado: false });
    });
  });

  describe('verificación del correo', () => {
    it('token con formato inválido o desconocido: 400 sin escribir', async () => {
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.verificarEmail('xyz', VISITANTE))).message).toBe('Enlace de verificación inválido.');
      expect(repositorio.buscarEnlace).not.toHaveBeenCalled();
      expect((await fallo(casos.verificarEmail(TOKEN, VISITANTE))).message).toBe('Enlace de verificación inválido.');
      expect(repositorio.buscarEnlace).toHaveBeenCalledWith('verificacion', `sha256(${TOKEN})`);
    });

    it('enlace ya usado: "ya verificado" sin volver a escribir', async () => {
      const { casos, repositorio, auditoria } = preparar();
      repositorio.buscarEnlace.mockResolvedValue(enlace({ usado: true }));
      expect(await casos.verificarEmail(TOKEN, VISITANTE)).toBe('ya_verificado');
      expect(repositorio.confirmarCorreo).not.toHaveBeenCalled();
      expect(auditoria.cuenta).not.toHaveBeenCalled();
    });

    it('enlace vencido: 410 con el código TOKEN_EXPIRADO', async () => {
      const { casos, repositorio } = preparar();
      repositorio.buscarEnlace.mockResolvedValue(enlace({ fecha_expiracion: new Date(Date.now() - 1000) }));
      const e = await fallo(casos.verificarEmail(TOKEN, VISITANTE));
      expect([e.motivo, e.message, e.codigo]).toEqual(['enlace_vencido', 'El enlace expiró. Solicite uno nuevo desde el inicio de sesión.', 'TOKEN_EXPIRADO']);
      expect(repositorio.confirmarCorreo).not.toHaveBeenCalled();
    });

    it('enlace vigente: confirma el correo, activa la cuenta y audita', async () => {
      const { casos, repositorio, auditoria } = preparar();
      repositorio.buscarEnlace.mockResolvedValue(enlace());
      expect(await casos.verificarEmail(TOKEN, VISITANTE)).toBe('verificado');
      expect(repositorio.confirmarCorreo).toHaveBeenCalledWith(31, 7);
      expect(auditoria.cuenta).toHaveBeenCalledWith(VISITANTE, 'EMAIL_VERIFICADO', { id: 7, email: 'guardia@ecu911.gob.ec' });
    });
  });

  describe('flujos de respuesta genérica (nunca fallan)', () => {
    it('reenviar verificación: solo a cuentas pendientes y como máximo una vez por minuto', async () => {
      const verificada = preparar(cuenta());
      await verificada.casos.reenviarVerificacion('guardia@ecu911.gob.ec');
      expect(verificada.repositorio.emitirEnlace).not.toHaveBeenCalled();

      const reciente = preparar(cuenta({ estado: 'pendiente', email_verificado: false }));
      reciente.repositorio.enlaceReciente.mockResolvedValue(true);
      await reciente.casos.reenviarVerificacion('guardia@ecu911.gob.ec');
      expect(reciente.repositorio.enlaceReciente).toHaveBeenCalledWith('verificacion', 7);
      expect(reciente.repositorio.emitirEnlace).not.toHaveBeenCalled();

      const pendiente = preparar(cuenta({ estado: 'pendiente', email_verificado: false }));
      await pendiente.casos.reenviarVerificacion(' GUARDIA@ecu911.gob.ec ');
      expect(pendiente.repositorio.porEmail).toHaveBeenCalledWith('guardia@ecu911.gob.ec');
      expect(pendiente.repositorio.emitirEnlace).toHaveBeenCalledWith('verificacion', 7, 'h'.repeat(64), 24 * 60);
      expect(pendiente.correo.verificacionCuenta).toHaveBeenCalledWith('guardia@ecu911.gob.ec', 'Luis Mendoza',
        `https://anpr.ecu911.gob.ec/verificar-email?token=${'b'.repeat(64)}`, 24);
      expect(pendiente.auditoria.cuenta).not.toHaveBeenCalled();
    });

    it('olvidé mi contraseña: solo cuentas activas sin bloqueo administrativo, una vez por minuto, y queda auditado', async () => {
      for (const c of [cuenta({ estado: 'inactivo' }), cuenta({ bloqueado: true }), null]) {
        const { casos, repositorio } = preparar(c);
        await casos.olvidePassword('guardia@ecu911.gob.ec', VISITANTE);
        expect(repositorio.emitirEnlace).not.toHaveBeenCalled();
      }
      const reciente = preparar();
      reciente.repositorio.enlaceReciente.mockResolvedValue(true);
      await reciente.casos.olvidePassword('guardia@ecu911.gob.ec', VISITANTE);
      expect(reciente.repositorio.emitirEnlace).not.toHaveBeenCalled();

      const { casos, repositorio, correo, auditoria } = preparar();
      await casos.olvidePassword('guardia@ecu911.gob.ec', VISITANTE);
      expect(repositorio.enlaceReciente).toHaveBeenCalledWith('restablecimiento', 7);
      expect(repositorio.emitirEnlace).toHaveBeenCalledWith('restablecimiento', 7, 'h'.repeat(64), 30);
      expect(correo.restablecerPassword).toHaveBeenCalledWith('guardia@ecu911.gob.ec', 'Luis Mendoza',
        `https://anpr.ecu911.gob.ec/restablecer-password?token=${'b'.repeat(64)}`, 30);
      expect(auditoria.cuenta).toHaveBeenCalledWith(VISITANTE, 'SOLICITUD_RESTABLECIMIENTO', { id: 7, email: 'guardia@ecu911.gob.ec' });
    });

    it('un fallo interno se registra en el log y no cambia la respuesta', async () => {
      const { casos, repositorio, registrarFallo } = preparar();
      const falla = new Error('sin conexión');
      repositorio.porEmail.mockRejectedValue(falla);
      await expect(casos.olvidePassword('guardia@ecu911.gob.ec', VISITANTE)).resolves.toBeUndefined();
      await expect(casos.reenviarVerificacion('guardia@ecu911.gob.ec')).resolves.toBeUndefined();
      expect(registrarFallo.mock.calls).toEqual([['olvidé contraseña', falla], ['reenviar verificación', falla]]);
    });
  });

  describe('restablecer la contraseña con el enlace', () => {
    it('valida el token y la política antes de buscar el enlace', async () => {
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.restablecerPassword({ token: 'x', password: NUEVA }, VISITANTE))).message).toBe('Enlace inválido.');
      expect((await fallo(casos.restablecerPassword({ token: TOKEN, password: 'debil' }, VISITANTE))).message)
        .toBe('La contraseña debe tener al menos 10 caracteres.');
      expect(repositorio.buscarEnlace).not.toHaveBeenCalled();
    });

    it('enlace usado o inexistente: 400; vencido: 410 sin código', async () => {
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.restablecerPassword({ token: TOKEN, password: NUEVA }, VISITANTE))).message)
        .toBe('El enlace ya fue usado o no es válido. Solicite uno nuevo.');
      repositorio.buscarEnlace.mockResolvedValue(enlace({ usado: true }));
      expect((await fallo(casos.restablecerPassword({ token: TOKEN, password: NUEVA }, VISITANTE))).tipo).toBe('validacion');
      repositorio.buscarEnlace.mockResolvedValue(enlace({ fecha_expiracion: new Date(Date.now() - 1000) }));
      const e = await fallo(casos.restablecerPassword({ token: TOKEN, password: NUEVA }, VISITANTE));
      expect([e.motivo, e.message, e.codigo]).toEqual(['enlace_vencido', 'El enlace expiró. Solicite uno nuevo.', undefined]);
      expect(repositorio.restablecerPassword).not.toHaveBeenCalled();
    });

    it('guarda la nueva contraseña cifrada, avisa al titular y audita', async () => {
      const { casos, repositorio, correo, auditoria } = preparar();
      repositorio.buscarEnlace.mockResolvedValue(enlace());
      await casos.restablecerPassword({ token: TOKEN, password: NUEVA }, VISITANTE);
      expect(repositorio.buscarEnlace).toHaveBeenCalledWith('restablecimiento', `sha256(${TOKEN})`);
      expect(repositorio.restablecerPassword).toHaveBeenCalledWith(31, 7, `bcrypt(${NUEVA})`);
      expect(correo.passwordCambiada).toHaveBeenCalledWith('guardia@ecu911.gob.ec', 'Luis Mendoza');
      expect(auditoria.cuenta).toHaveBeenCalledWith(VISITANTE, 'PASSWORD_RESTABLECIDA', { id: 7, email: 'guardia@ecu911.gob.ec' });
    });
  });

  describe('sesión vigente', () => {
    it('401 si la cuenta ya no está activa o no existe', async () => {
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.sesionActual(7))).motivo).toBe('sesion_inactiva');
      repositorio.sesion.mockResolvedValue({
        id: 7, email: 'guardia@ecu911.gob.ec', nombre_completo: 'Luis Mendoza', cargo: null, estado: 'inactivo', rol: 'Guardia',
        rol_nombre: 'Guardia', fecha_ultimo_acceso: null, fecha_creacion: new Date('2026-09-01T10:00:00Z'),
      });
      const e = await fallo(casos.sesionActual(7));
      expect([e.motivo, e.message]).toEqual(['sesion_inactiva', 'La cuenta ya no está activa.']);
    });

    it('datos con el rol actual y sus permisos', async () => {
      const { casos, repositorio } = preparar();
      const creada = new Date('2026-09-01T10:00:00Z');
      repositorio.sesion.mockResolvedValue({
        id: 4, email: 'gestor@ecu911.gob.ec', nombre_completo: 'Gabriela Gestora', cargo: 'Gestión de accesos', estado: 'activo',
        rol: 'GestorPermisos', rol_nombre: 'Gestor de permisos', fecha_ultimo_acceso: null, fecha_creacion: creada,
      });
      expect(await casos.sesionActual(4)).toEqual({
        id: 4, email: 'gestor@ecu911.gob.ec', username: 'gestor@ecu911.gob.ec', nombre: 'Gabriela Gestora', cargo: 'Gestión de accesos',
        rol: 'GestorPermisos', rol_nombre: 'Gestor de permisos', permisos: ['listas:ver', 'padron:gestionar', 'solicitudes:resolver'],
        fecha_ultimo_acceso: null, fecha_creacion: creada,
      });
    });
  });

  describe('perfil y contraseña propios', () => {
    it('perfil: nombre solo con letras y cargo alfanumérico; guarda y audita sobre la propia cuenta', async () => {
      const { casos, repositorio, auditoria } = preparar();
      expect((await fallo(casos.actualizarPerfil({ nombre_completo: 'Luis M3ndoza' }, GUARDIA))).tipo).toBe('validacion');
      expect((await fallo(casos.actualizarPerfil({ nombre_completo: 'Luis Mendoza', cargo: 'Garita <1>' }, GUARDIA))).tipo).toBe('validacion');
      expect(repositorio.actualizarPerfil).not.toHaveBeenCalled();
      await casos.actualizarPerfil({ nombre_completo: ' Luis  Mendoza ', cargo: 'Guardia de garita' }, GUARDIA);
      expect(repositorio.actualizarPerfil).toHaveBeenCalledWith(7, { nombre_completo: 'Luis Mendoza', cargo: 'Guardia de garita' });
      expect(auditoria.cuenta).toHaveBeenCalledWith(GUARDIA, 'PERFIL_ACTUALIZADO', { id: 7, email: 'guardia@ecu911.gob.ec' });
    });

    it.each([
      [{ actual: CLAVE, nueva: 'debil' }, 'La contraseña debe tener al menos 10 caracteres.'],
      [{ actual: CLAVE, nueva: CLAVE }, 'La nueva contraseña debe ser distinta de la actual.'],
      [{ actual: 'Otra#Clave2026', nueva: NUEVA }, 'La contraseña actual no es correcta.'],
    ])('cambio de contraseña %j → 400', async (cuerpo, mensaje) => {
      const { casos, repositorio } = preparar();
      const e = await fallo(casos.cambiarPassword(cuerpo, GUARDIA));
      expect([e.tipo, e.message]).toEqual(['validacion', mensaje]);
      expect(repositorio.cambiarPassword).not.toHaveBeenCalled();
    });

    it('cambio de contraseña: guarda la nueva cifrada, avisa por correo y audita', async () => {
      const { casos, repositorio, correo, auditoria } = preparar();
      await casos.cambiarPassword({ actual: CLAVE, nueva: NUEVA }, GUARDIA);
      expect(repositorio.credenciales).toHaveBeenCalledWith(7);
      expect(repositorio.cambiarPassword).toHaveBeenCalledWith(7, `bcrypt(${NUEVA})`);
      expect(correo.passwordCambiada).toHaveBeenCalledWith('guardia@ecu911.gob.ec', 'Luis Mendoza');
      expect(auditoria.cuenta).toHaveBeenCalledWith(GUARDIA, 'PASSWORD_CAMBIADA', { id: 7, email: 'guardia@ecu911.gob.ec' });
    });
  });
});
