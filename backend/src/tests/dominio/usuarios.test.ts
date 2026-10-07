import {
  bloqueoTemporalVigente, describirCambios, enlaceVencido, esAdministradorActivo, evaluarIntentoFallido, leerAltaUsuario,
  leerEdicionUsuario, leerPerfil, leerRegistro, limiteAuditoria, minutosRestantes, normalizarCorreo, pierdeAdministracion,
  RE_TOKEN_ENLACE, validarCorreoInstitucional, validarEstado, validarPassword, validarRol,
} from '../../dominio/usuarios';

/** Reglas puras de las cuentas del personal (sin base de datos). */

const DOMINIOS = ['ecu911.gob.ec'];
const error = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

describe('Dominio · usuarios', () => {
  describe('correo institucional', () => {
    it('normaliza y acepta un dominio permitido', () => {
      expect(validarCorreoInstitucional('  Ana.Villacis@ECU911.gob.ec ', DOMINIOS)).toEqual({ ok: true, valor: 'ana.villacis@ecu911.gob.ec' });
    });

    it.each([
      ['', 'El campo «Correo electrónico» es obligatorio.'],
      ['ana@', 'Correo electrónico inválido.'],
      ['ana villacis@ecu911.gob.ec', 'Correo electrónico inválido.'],
      [['ana@ecu911.gob.ec'], 'Correo electrónico inválido.'],
      ['ana@gmail.com', 'Solo se aceptan correos de: @ecu911.gob.ec.'],
    ])('%j → %s', (valor, mensaje) => {
      expect(error(validarCorreoInstitucional(valor, DOMINIOS))).toBe(mensaje);
    });

    it('sin dominios configurados acepta cualquier correo válido', () => {
      expect(validarCorreoInstitucional('ana@gmail.com', []).ok).toBe(true);
    });

    it('el correo de búsqueda solo se normaliza (no se valida)', () => {
      expect(normalizarCorreo('  GESTOR@ecu911.gob.ec ')).toBe('gestor@ecu911.gob.ec');
      expect(normalizarCorreo(undefined)).toBe('');
    });
  });

  it.each([
    ['Corta#1A', 'La contraseña debe tener al menos 10 caracteres.'],
    [`Aa1#${'x'.repeat(125)}`, 'La contraseña es demasiado larga.'],
    ['sinmayuscula#2026', 'La contraseña debe incluir mayúscula, minúscula, número y un símbolo.'],
    ['SinSimbolo2026', 'La contraseña debe incluir mayúscula, minúscula, número y un símbolo.'],
    ['ClaveSegura#2026', null],
  ])('política de contraseñas: %s', (password, mensaje) => {
    expect(error(validarPassword(password))).toBe(mensaje);
  });

  it('rol y estado: solo los valores vigentes', () => {
    expect(validarRol('GestorPermisos').ok).toBe(true);
    expect(error(validarRol('Operador'))).toBe('Rol inválido.');
    expect(validarEstado('inactivo').ok).toBe(true);
    expect(error(validarEstado('borrado'))).toBe('Estado inválido.');
  });

  describe('alta por el administrador', () => {
    const ALTA = { nombre_completo: '  María   José Torres ', email: 'MARIA@ecu911.gob.ec', cargo: ' Jefa de turno - Garita 2 ', rol: 'Guardia' };

    it('recorta, colapsa espacios y deja el cargo vacío en null', () => {
      expect(leerAltaUsuario(ALTA, DOMINIOS)).toEqual({
        ok: true, valor: { email: 'maria@ecu911.gob.ec', nombre_completo: 'María José Torres', cargo: 'Jefa de turno - Garita 2', rol: 'Guardia' },
      });
      expect(leerAltaUsuario({ ...ALTA, cargo: '   ' }, DOMINIOS)).toMatchObject({ ok: true, valor: { cargo: null } });
    });

    it.each([
      [{ nombre_completo: 'Ana 2' }, 'Nombres y apellidos: solo letras, espacios y . \' - &.'],
      [{ nombre_completo: 'Al' }, 'Nombres y apellidos: mínimo 3 caracteres.'],
      [{ nombre_completo: 'x'.repeat(151) }, 'Nombres y apellidos: máximo 150 caracteres.'],
      [{ cargo: 'Jefe <b>' }, 'Cargo: letras, números, espacios y . , / # ( ) -.'],
      [{ cargo: 'Jefe; DROP TABLE' }, 'Cargo: letras, números, espacios y . , / # ( ) -.'],
      [{ rol: 'Admin ' }, 'Rol inválido.'],
    ])('rechaza %j', (cambio, mensaje) => {
      expect(error(leerAltaUsuario({ ...ALTA, ...cambio }, DOMINIOS))).toBe(mensaje);
    });

    it('sin cuerpo: el primer error es el nombre obligatorio', () => {
      expect(error(leerAltaUsuario(undefined, DOMINIOS))).toBe('El campo «Nombres y apellidos» es obligatorio.');
    });
  });

  it('registro público y configuración inicial: además valida la contraseña', () => {
    const base = { nombre_completo: 'Carlos Andrade', email: 'carlos@ecu911.gob.ec', password: 'ClaveSegura#2026' };
    expect(leerRegistro(base, DOMINIOS)).toEqual({ ok: true, valor: { ...base, cargo: null } });
    expect(error(leerRegistro({ ...base, password: 'debil' }, DOMINIOS))).toBe('La contraseña debe tener al menos 10 caracteres.');
  });

  it('perfil propio: nombre obligatorio y cargo alfanumérico', () => {
    expect(leerPerfil({ nombre_completo: 'María Torres', cargo: 'Supervisora (turno B)' }))
      .toEqual({ ok: true, valor: { nombre_completo: 'María Torres', cargo: 'Supervisora (turno B)' } });
    expect(error(leerPerfil({ cargo: 'x' }))).toBe('El campo «Nombres y apellidos» es obligatorio.');
    expect(error(leerPerfil({ nombre_completo: 'María Torres', cargo: 'x'.repeat(101) }))).toBe('Cargo: máximo 100 caracteres.');
  });

  describe('edición por el administrador', () => {
    // Nombre guardado con el formato anterior (admitía números): no impide cambiar el rol
    const ACTUAL = { nombre_completo: 'Operador 1', cargo: null as string | null, rol: 'Guardia' as const, estado: 'activo' as const };

    it('solo valida lo que llega y conserva el resto', () => {
      expect(leerEdicionUsuario({ rol: 'GestorPermisos' }, ACTUAL)).toEqual({
        ok: true, valor: { nombre_completo: 'Operador 1', cargo: null, rol: 'GestorPermisos', estado: 'activo' },
      });
      expect(error(leerEdicionUsuario({ nombre_completo: 'Operador 2' }, ACTUAL))).toContain('Nombres y apellidos');
    });

    it('un cargo vacío lo borra; null en rol o estado conserva el valor guardado', () => {
      expect(leerEdicionUsuario({ cargo: '', rol: null, estado: null }, { ...ACTUAL, cargo: 'Garita' }))
        .toMatchObject({ ok: true, valor: { cargo: null, rol: 'Guardia', estado: 'activo' } });
    });

    it('describe los cambios para la auditoría', () => {
      expect(describirCambios(ACTUAL, { ...ACTUAL, rol: 'Admin', estado: 'inactivo' })).toBe('rol Guardia → Admin; estado activo → inactivo');
      expect(describirCambios(ACTUAL, { ...ACTUAL, cargo: 'Garita' })).toBe('datos personales');
      expect(describirCambios(ACTUAL, { ...ACTUAL })).toBe('sin cambios');
    });
  });

  it('continuidad de la administración', () => {
    expect(esAdministradorActivo({ rol: 'Admin', estado: 'activo', bloqueado: false })).toBe(true);
    expect(esAdministradorActivo({ rol: 'Admin', estado: 'activo', bloqueado: true })).toBe(false);
    expect(esAdministradorActivo({ rol: 'Admin', estado: 'pendiente', bloqueado: false })).toBe(false);
    expect(esAdministradorActivo({ rol: 'Guardia', estado: 'activo', bloqueado: false })).toBe(false);
    expect(pierdeAdministracion({ rol: 'Admin' }, { rol: 'Guardia', estado: 'activo' })).toBe(true);
    expect(pierdeAdministracion({ rol: 'Admin' }, { rol: 'Admin', estado: 'inactivo' })).toBe(true);
    expect(pierdeAdministracion({ rol: 'Admin' }, { rol: 'Admin', estado: 'activo' })).toBe(false);
    expect(pierdeAdministracion({ rol: 'Guardia' }, { rol: 'Guardia', estado: 'inactivo' })).toBe(false);
  });

  describe('inicio de sesión y enlaces', () => {
    const AHORA = new Date('2026-10-04T12:00:00Z');

    it('intentos fallidos: al llegar al máximo bloquea y reinicia el contador', () => {
      expect(evaluarIntentoFallido(0, 5)).toEqual({ intentos: 1, bloquear: false });
      expect(evaluarIntentoFallido(3, 5)).toEqual({ intentos: 4, bloquear: false });
      expect(evaluarIntentoFallido(4, 5)).toEqual({ intentos: 0, bloquear: true });
    });

    it('bloqueo temporal vigente y minutos restantes (redondeo hacia arriba)', () => {
      expect(bloqueoTemporalVigente(null, AHORA)).toBe(false);
      expect(bloqueoTemporalVigente('2026-10-04T11:59:00Z', AHORA)).toBe(false);
      expect(bloqueoTemporalVigente(new Date('2026-10-04T12:10:00Z'), AHORA)).toBe(true);
      expect(minutosRestantes('2026-10-04T12:09:01Z', AHORA)).toBe(10);
    });

    it('enlace vencido y formato del token', () => {
      expect(enlaceVencido('2026-10-04T11:59:59Z', AHORA)).toBe(true);
      expect(enlaceVencido('2026-10-04T12:30:00Z', AHORA)).toBe(false);
      expect(RE_TOKEN_ENLACE.test('a'.repeat(64))).toBe(true);
      expect(RE_TOKEN_ENLACE.test('A'.repeat(64))).toBe(false);
      expect(RE_TOKEN_ENLACE.test('a'.repeat(63))).toBe(false);
    });
  });

  it.each([
    [undefined, 200], ['', 200], ['abc', 200], ['0', 200],
    ['50', 50], ['3', 10], ['-5', 10], ['1.5', 10], ['5000', 500],
  ])('límite de la auditoría %j → %d (mismo cálculo que el contrato vigente)', (valor, esperado) => {
    expect(limiteAuditoria(valor)).toBe(esperado);
  });
});
