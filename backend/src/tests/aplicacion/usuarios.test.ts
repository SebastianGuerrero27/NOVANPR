import { casosUsuarios, type RepositorioUsuarios, type UsuarioDTO } from '../../aplicacion/usuarios';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';

/** Casos de uso de la administración de cuentas con dobles de prueba: sin base de datos, sin correo. */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administradora', rol: 'Admin', ip: '10.0.0.1' };

const cuenta = (parcial: Partial<UsuarioDTO> = {}): UsuarioDTO => ({
  id: 7, email: 'guardia@ecu911.gob.ec', nombre_completo: 'Luis Mendoza', cargo: 'Guardia de garita', rol: 'Guardia',
  rol_nombre: 'Guardia', estado: 'activo', email_verificado: true, bloqueado: false, bloqueo_temporal_hasta: null,
  intentos_fallidos: 0, fecha_ultimo_acceso: null, fecha_creacion: new Date('2026-09-01T10:00:00Z'), creado_por: 'admin@ecu911.gob.ec',
  ...parcial,
});

function preparar(guardada: UsuarioDTO | null = cuenta(), administradoresActivos = 2) {
  const repositorio: jest.Mocked<RepositorioUsuarios> = {
    listar: jest.fn().mockResolvedValue([]),
    obtener: jest.fn().mockResolvedValue(guardada),
    roles: jest.fn().mockResolvedValue([
      { rol: 'Admin', nombre: 'Administrador', descripcion: 'Todo' },
      { rol: undefined, nombre: 'Operador', descripcion: 'Rol retirado' },
    ]),
    existeEmail: jest.fn().mockResolvedValue(false),
    crear: jest.fn().mockResolvedValue(15),
    actualizar: jest.fn().mockResolvedValue(undefined),
    bloquear: jest.fn().mockResolvedValue(undefined),
    desbloquear: jest.fn().mockResolvedValue(undefined),
    darDeBaja: jest.fn().mockResolvedValue(undefined),
    contarAdministradoresActivos: jest.fn().mockResolvedValue(administradoresActivos),
    emitirEnlaceRestablecimiento: jest.fn().mockResolvedValue(undefined),
    auditoria: jest.fn().mockResolvedValue({ acciones: [], accesos: [] }),
  };
  const auditoria = { cuenta: jest.fn().mockResolvedValue(undefined), acceso: jest.fn().mockResolvedValue(undefined) };
  const correo = { definirPasswordCuentaNueva: jest.fn().mockResolvedValue(true), restablecerPassword: jest.fn().mockResolvedValue(true) };
  const tokens = { generar: jest.fn().mockReturnValue({ token: 'a'.repeat(64), hash: 'h'.repeat(64) }) };
  const claves = { inutilizable: jest.fn().mockResolvedValue('$2a$10$inutilizable') };
  const invalidarSesiones = jest.fn();
  const casos = casosUsuarios({
    repositorio, auditoria, correo, tokens, claves, invalidarSesiones,
    dominiosPermitidos: () => ['ecu911.gob.ec'],
    urlFrontend: () => 'https://anpr.ecu911.gob.ec',
  });
  return { casos, repositorio, auditoria, correo, tokens, claves, invalidarSesiones };
}

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

const ALTA = { nombre_completo: 'Ana Villacís', email: 'Ana.Villacis@ECU911.gob.ec', cargo: 'Agente de seguridad', rol: 'Guardia' };

describe('Casos de uso · usuarios', () => {
  describe('crear', () => {
    it('valida, crea con clave inutilizable, emite el enlace de 48 h, envía el correo y audita', async () => {
      const { casos, repositorio, correo, auditoria, claves } = preparar(cuenta({ id: 15 }));
      const r = await casos.crear(ALTA, ADMIN);
      expect(r.enviado).toBe(true);
      expect(r.usuario.id).toBe(15);
      expect(claves.inutilizable).toHaveBeenCalled();
      expect(repositorio.crear).toHaveBeenCalledWith({
        email: 'ana.villacis@ecu911.gob.ec', nombre_completo: 'Ana Villacís', cargo: 'Agente de seguridad', rol: 'Guardia',
        passwordHash: '$2a$10$inutilizable',
      }, 1);
      expect(repositorio.emitirEnlaceRestablecimiento).toHaveBeenCalledWith(15, 'h'.repeat(64), 48 * 60);
      expect(correo.definirPasswordCuentaNueva).toHaveBeenCalledWith('ana.villacis@ecu911.gob.ec', 'Ana Villacís',
        `https://anpr.ecu911.gob.ec/restablecer-password?token=${'a'.repeat(64)}`, 48, 'Guardia');
      expect(auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'USUARIO_CREADO', { id: 15, email: 'ana.villacis@ecu911.gob.ec' }, 'Rol Guardia');
    });

    it.each([
      [{ ...ALTA, nombre_completo: 'Ana Villacís 2' }, 'Nombres y apellidos: solo letras'],
      [{ ...ALTA, nombre_completo: '  ' }, 'El campo «Nombres y apellidos» es obligatorio.'],
      [{ ...ALTA, nombre_completo: 'Al' }, 'Nombres y apellidos: mínimo 3 caracteres.'],
      [{ ...ALTA, email: 'ana@' }, 'Correo electrónico inválido.'],
      [{ ...ALTA, email: 'ana@gmail.com' }, 'Solo se aceptan correos de: @ecu911.gob.ec.'],
      [{ ...ALTA, cargo: 'Jefe <b>' }, 'Cargo: letras, números'],
      [{ ...ALTA, cargo: 'Jefe; DROP' }, 'Cargo: letras, números'],
      [{ ...ALTA, cargo: 'x'.repeat(101) }, 'Cargo: máximo 100 caracteres.'],
      [{ ...ALTA, rol: 'Supervisor' }, 'Rol inválido.'],
    ])('rechaza %j sin tocar la base', async (entrada, mensaje) => {
      const { casos, repositorio } = preparar();
      const e = await fallo(casos.crear(entrada, ADMIN));
      expect(e.tipo).toBe('validacion');
      expect(e.message).toContain(mensaje);
      expect(repositorio.existeEmail).not.toHaveBeenCalled();
      expect(repositorio.crear).not.toHaveBeenCalled();
    });

    it('409 si ya existe una cuenta con el correo', async () => {
      const { casos, repositorio } = preparar();
      repositorio.existeEmail.mockResolvedValue(true);
      const e = await fallo(casos.crear(ALTA, ADMIN));
      expect([e.tipo, e.message]).toEqual(['conflicto', 'Ya existe una cuenta con ese correo.']);
      expect(repositorio.crear).not.toHaveBeenCalled();
    });

    it('si el correo no sale lo informa (la cuenta igual se crea)', async () => {
      const { casos, correo } = preparar(cuenta({ id: 15 }));
      correo.definirPasswordCuentaNueva.mockResolvedValue(false);
      expect((await casos.crear(ALTA, ADMIN)).enviado).toBe(false);
    });
  });

  describe('obtener (detalle)', () => {
    it('devuelve la cuenta con el mismo formato del listado', async () => {
      const { casos } = preparar();
      expect(await casos.obtener(7)).toEqual(cuenta());
    });

    it('404 si no existe', async () => {
      const { casos } = preparar(null);
      const e = await fallo(casos.obtener(99));
      expect([e.tipo, e.message]).toEqual(['no_encontrado', 'Usuario no encontrado.']);
    });
  });

  it('roles: solo los tres roles vigentes, con sus permisos', async () => {
    const { casos } = preparar();
    const roles = await casos.roles();
    expect(roles.map(r => r.rol)).toEqual(['Admin']);
    expect(roles[0].permisos).toContain('usuarios:gestionar');
  });

  describe('editar', () => {
    it('conserva lo que no llega, invalida las sesiones y audita los cambios', async () => {
      const { casos, repositorio, invalidarSesiones, auditoria } = preparar();
      await casos.editar(7, { rol: 'GestorPermisos', estado: 'inactivo' }, ADMIN);
      expect(repositorio.actualizar).toHaveBeenCalledWith(7, {
        nombre_completo: 'Luis Mendoza', cargo: 'Guardia de garita', rol: 'GestorPermisos', estado: 'inactivo',
      });
      expect(invalidarSesiones).toHaveBeenCalledWith(7);
      expect(auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'USUARIO_ACTUALIZADO', { id: 7, email: 'guardia@ecu911.gob.ec' },
        'rol Guardia → GestorPermisos; estado activo → inactivo');
    });

    it('valida solo lo que llega: nombre con números y cargo con caracteres prohibidos', async () => {
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.editar(7, { nombre_completo: 'Luis 3' }, ADMIN))).tipo).toBe('validacion');
      expect((await fallo(casos.editar(7, { cargo: 'Guardia <script>' }, ADMIN))).tipo).toBe('validacion');
      expect((await fallo(casos.editar(7, { estado: 'borrado' }, ADMIN))).message).toBe('Estado inválido.');
      expect(repositorio.actualizar).not.toHaveBeenCalled();
    });

    it('404 si la cuenta no existe', async () => {
      expect((await fallo(preparar(null).casos.editar(99, { rol: 'Admin' }, ADMIN))).tipo).toBe('no_encontrado');
    });

    it('nadie se quita a sí mismo la administración; debe quedar un administrador activo (400, contrato vigente)', async () => {
      const propio = preparar(cuenta({ id: 1, rol: 'Admin' }));
      const e1 = await fallo(propio.casos.editar(1, { estado: 'inactivo' }, ADMIN));
      expect([e1.tipo, e1.message]).toEqual(['validacion', 'No puede quitarse a sí mismo el rol de administrador ni desactivarse.']);
      const ultimo = preparar(cuenta({ id: 2, rol: 'Admin' }), 1);
      const e2 = await fallo(ultimo.casos.editar(2, { rol: 'Guardia' }, ADMIN));
      expect([e2.tipo, e2.message]).toEqual(['validacion', 'Debe existir al menos un administrador activo.']);
      expect(ultimo.repositorio.actualizar).not.toHaveBeenCalled();
    });
  });

  describe('bloquear', () => {
    it('bloquea, invalida las sesiones y audita el motivo', async () => {
      const { casos, repositorio, invalidarSesiones, auditoria } = preparar();
      await casos.bloquear(7, 'Fin de la relación laboral', ADMIN);
      expect(repositorio.bloquear).toHaveBeenCalledWith(7);
      expect(invalidarSesiones).toHaveBeenCalledWith(7);
      expect(auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'USUARIO_BLOQUEADO', { id: 7, email: 'guardia@ecu911.gob.ec' }, 'Fin de la relación laboral');
    });

    it('el motivo es opcional pero, si llega, es texto libre sin < > de hasta 300 caracteres', async () => {
      const sinMotivo = preparar();
      await sinMotivo.casos.bloquear(7, undefined, ADMIN);
      expect(sinMotivo.auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'USUARIO_BLOQUEADO', expect.any(Object), undefined);
      const { casos, repositorio } = preparar();
      expect((await fallo(casos.bloquear(7, '<img src=x>', ADMIN))).tipo).toBe('validacion');
      expect((await fallo(casos.bloquear(7, 'x'.repeat(301), ADMIN))).tipo).toBe('validacion');
      expect(repositorio.bloquear).not.toHaveBeenCalled();
    });

    it('no se bloquea la propia cuenta ni al último administrador', async () => {
      expect((await fallo(preparar(cuenta({ id: 1, rol: 'Admin' })).casos.bloquear(1, undefined, ADMIN))).message)
        .toBe('No puede bloquear su propia cuenta.');
      expect((await fallo(preparar(cuenta({ id: 2, rol: 'Admin' }), 1).casos.bloquear(2, undefined, ADMIN))).message)
        .toBe('Debe existir al menos un administrador activo.');
    });
  });

  it('desbloquear: quita los bloqueos, invalida las sesiones y audita', async () => {
    const { casos, repositorio, invalidarSesiones, auditoria } = preparar(cuenta({ bloqueado: true }));
    await casos.desbloquear(7, ADMIN);
    expect(repositorio.desbloquear).toHaveBeenCalledWith(7);
    expect(invalidarSesiones).toHaveBeenCalledWith(7);
    expect(auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'USUARIO_DESBLOQUEADO', { id: 7, email: 'guardia@ecu911.gob.ec' });
  });

  it('enviarEnlacePassword: anula los anteriores, emite uno de 30 min, envía el correo y audita', async () => {
    const { casos, repositorio, correo, auditoria } = preparar();
    expect(await casos.enviarEnlacePassword(7, ADMIN)).toBe(true);
    expect(repositorio.emitirEnlaceRestablecimiento).toHaveBeenCalledWith(7, 'h'.repeat(64), 30);
    expect(correo.restablecerPassword).toHaveBeenCalledWith('guardia@ecu911.gob.ec', 'Luis Mendoza',
      `https://anpr.ecu911.gob.ec/restablecer-password?token=${'a'.repeat(64)}`, 30);
    expect(auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'ENLACE_PASSWORD_ENVIADO', { id: 7, email: 'guardia@ecu911.gob.ec' });
  });

  describe('darDeBaja (DELETE, baja lógica)', () => {
    it('deja la cuenta inactiva, cierra sus sesiones como la desactivación y audita el motivo', async () => {
      const { casos, repositorio, invalidarSesiones, auditoria } = preparar();
      repositorio.obtener.mockResolvedValueOnce(cuenta()).mockResolvedValueOnce(cuenta({ estado: 'inactivo' }));
      const u = await casos.darDeBaja(7, '  Fin del   contrato ', ADMIN);
      expect(u.estado).toBe('inactivo');
      expect(repositorio.darDeBaja).toHaveBeenCalledWith(7);
      expect(invalidarSesiones).toHaveBeenCalledWith(7);
      expect(auditoria.cuenta).toHaveBeenCalledWith(ADMIN, 'USUARIO_DADO_DE_BAJA', { id: 7, email: 'guardia@ecu911.gob.ec' },
        'estado activo → inactivo · Fin del contrato');
    });

    it('403 al intentar dar de baja la propia cuenta (antes de consultar nada)', async () => {
      const { casos, repositorio } = preparar(cuenta({ id: 1, rol: 'Admin' }));
      const e = await fallo(casos.darDeBaja(1, 'Me retiro del sistema', ADMIN));
      expect([e.tipo, e.message]).toEqual(['prohibido', 'No puede dar de baja su propia cuenta.']);
      expect(repositorio.obtener).not.toHaveBeenCalled();
      expect(repositorio.darDeBaja).not.toHaveBeenCalled();
    });

    it('409 si es el único administrador activo', async () => {
      const { casos, repositorio, invalidarSesiones } = preparar(cuenta({ id: 2, rol: 'Admin' }), 1);
      const e = await fallo(casos.darDeBaja(2, 'Reasignación de funciones', ADMIN));
      expect(e.tipo).toBe('conflicto');
      expect(e.message).toMatch(/único administrador activo/);
      expect(repositorio.darDeBaja).not.toHaveBeenCalled();
      expect(invalidarSesiones).not.toHaveBeenCalled();
    });

    it('un administrador bloqueado o con otros administradores activos sí puede darse de baja', async () => {
      const bloqueado = preparar(cuenta({ id: 2, rol: 'Admin', bloqueado: true }), 1);
      await bloqueado.casos.darDeBaja(2, 'Cuenta en desuso', ADMIN);
      expect(bloqueado.repositorio.darDeBaja).toHaveBeenCalledWith(2);
      const conOtros = preparar(cuenta({ id: 2, rol: 'Admin' }), 2);
      await conOtros.casos.darDeBaja(2, 'Cuenta en desuso', ADMIN);
      expect(conOtros.repositorio.darDeBaja).toHaveBeenCalledWith(2);
    });

    it.each([
      [undefined, 'El campo «Motivo de la baja» es obligatorio.'],
      ['   ', 'El campo «Motivo de la baja» es obligatorio.'],
      ['corto', null],
      ['baja', 'Motivo de la baja: mínimo 5 caracteres.'],
      ['x'.repeat(301), 'Motivo de la baja: máximo 300 caracteres.'],
      ['<script>alert(1)</script>', 'Motivo de la baja: sin los caracteres < >'],
      [{ texto: 'objeto' }, 'Motivo de la baja: valor inválido.'],
    ])('motivo %j', async (motivo, mensaje) => {
      const { casos, repositorio } = preparar();
      if (mensaje === null) {
        await casos.darDeBaja(7, motivo, ADMIN);
        expect(repositorio.darDeBaja).toHaveBeenCalled();
        return;
      }
      const e = await fallo(casos.darDeBaja(7, motivo, ADMIN));
      expect(e.tipo).toBe('validacion');
      expect(e.message).toContain(mensaje);
      expect(repositorio.darDeBaja).not.toHaveBeenCalled();
    });

    it('404 si no existe y 409 si ya estaba dada de baja', async () => {
      expect((await fallo(preparar(null).casos.darDeBaja(99, 'Fin del contrato', ADMIN))).tipo).toBe('no_encontrado');
      const e = await fallo(preparar(cuenta({ estado: 'inactivo' })).casos.darDeBaja(7, 'Fin del contrato', ADMIN));
      expect([e.tipo, e.message]).toEqual(['conflicto', 'La cuenta ya está dada de baja.']);
    });
  });

  it('auditoría: límite entre 10 y 500, 200 si no es un entero', async () => {
    const { casos, repositorio } = preparar();
    await casos.auditoria('5000');
    await casos.auditoria('3');
    await casos.auditoria('abc');
    await casos.auditoria(undefined);
    expect(repositorio.auditoria.mock.calls.map(c => c[0])).toEqual([500, 10, 200, 200]);
  });
});
