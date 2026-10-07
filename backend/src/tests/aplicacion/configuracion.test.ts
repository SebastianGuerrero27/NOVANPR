import { casosConfiguracion, type ParametroDTO, type RepositorioConfiguracion } from '../../aplicacion/configuracion';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import { type ReglaParametro, validarParametro } from '../../dominio/configuracion';
import { DEFINICIONES } from '../../infraestructura/servicios/configuracion';

/** Configuración del sistema: reglas por tipo de parámetro y casos de uso con dobles (sin base de datos). */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administrador', rol: 'Admin', ip: '10.0.0.1' };

const SESION: ReglaParametro = { clave: 'sesion_horas', tipo: 'entero', etiqueta: 'Duración de la sesión (horas)', min: 1, max: 24 };
const REGISTRO: ReglaParametro = { clave: 'registro_publico_habilitado', tipo: 'booleano', etiqueta: 'Registro público de cuentas' };
const DOMINIOS: ReglaParametro = { clave: 'dominios_correo', tipo: 'lista', etiqueta: 'Dominios de correo permitidos' };
const CRITERIO: ReglaParametro = {
  clave: 'autorizacion_criterio', tipo: 'opcion', etiqueta: 'Criterio de autorización automática',
  opciones: [{ valor: 'validez_y_confianza' }, { valor: 'validez' }, { valor: 'confianza' }],
};
const UNIDAD: ReglaParametro = { clave: 'unidad_institucional', tipo: 'texto', etiqueta: 'Unidad institucional' };

const valor = (def: ReglaParametro, entrada: unknown) => {
  const r = validarParametro(def, entrada);
  return r.ok ? r.valor : `ERROR: ${r.error}`;
};

describe('Parámetros del sistema · validación por tipo declarado', () => {
  it('entero: solo dígitos dentro del rango declarado', () => {
    expect(valor(SESION, '8')).toBe('8');
    expect(valor(SESION, ' 08 ')).toBe('8');
    expect(valor(SESION, 12)).toBe('12');
    expect(valor(SESION, '0')).toBe('ERROR: Duración de la sesión (horas): mínimo 1.');
    expect(valor(SESION, '25')).toBe('ERROR: Duración de la sesión (horas): máximo 24.');
    for (const invalido of ['1.5', '1e1', '+5', 'ocho', '', null, [5], { n: 5 }]) {
      expect(validarParametro(SESION, invalido).ok).toBe(false);
    }
  });

  it('booleano: true o false', () => {
    expect(valor(REGISTRO, 'true')).toBe('true');
    expect(valor(REGISTRO, false)).toBe('false');
    for (const invalido of ['si', '1', 'verdadero', '', undefined]) expect(validarParametro(REGISTRO, invalido).ok).toBe(false);
  });

  it('dominios de correo: nombres de host válidos, en minúsculas, sin @ ni repetidos', () => {
    expect(valor(DOMINIOS, ' @ECU911.gob.ec, ecu911.gob.ec ,gob.ec')).toBe('ecu911.gob.ec,gob.ec');
    expect(valor(DOMINIOS, ['ecu911.gob.ec', 'xn--maana-pta.ec'])).toBe('ecu911.gob.ec,xn--maana-pta.ec');
    expect(valor(DOMINIOS, ' , ')).toBe('ERROR: Dominios de correo permitidos: indique al menos un dominio.');
    for (const invalido of ['ecu911', '192.168.1.10', '-ecu911.gob.ec', 'ecu_911.gob.ec', 'ecu911..gob.ec', 'ecu911.gob.e1', 'ecu<911>.ec']) {
      expect(valor(DOMINIOS, invalido)).toMatch(/^ERROR: Dominios de correo permitidos: dominio inválido/);
    }
    const muchos = Array.from({ length: 40 }, (_, i) => `dependencia${i}.ecu911.gob.ec`).join(',');
    expect(valor(DOMINIOS, muchos)).toBe('ERROR: Dominios de correo permitidos: máximo 500 caracteres.');
  });

  it('opción: uno de los valores declarados', () => {
    expect(valor(CRITERIO, 'validez')).toBe('validez');
    expect(validarParametro(CRITERIO, 'cualquiera').ok).toBe(false);
  });

  it('texto: libre, obligatorio, hasta 150 caracteres y sin < >', () => {
    expect(valor(UNIDAD, '  Coordinación Zonal 3  ·  Ambato ')).toBe('Coordinación Zonal 3 · Ambato');
    expect(valor(UNIDAD, '<b>ECU 911</b>')).toMatch(/^ERROR: Unidad institucional: sin los caracteres < >/);
    expect(validarParametro(UNIDAD, 'x'.repeat(151)).ok).toBe(false);
    expect(validarParametro(UNIDAD, '   ').ok).toBe(false);
  });

  it('cada parámetro del sistema acepta su propio valor por omisión', () => {
    for (const d of DEFINICIONES) expect({ clave: d.clave, ok: validarParametro(d, d.omision).ok }).toEqual({ clave: d.clave, ok: true });
  });
});

describe('Casos de uso · configuración', () => {
  function preparar() {
    const parametros: ParametroDTO[] = [
      { ...SESION, valor: '8', origen: 'omision' },
      { ...REGISTRO, valor: 'true', origen: 'entorno' },
      { ...DOMINIOS, valor: 'ecu911.gob.ec', origen: 'entorno' },
    ];
    const repositorio: jest.Mocked<RepositorioConfiguracion> = {
      definiciones: jest.fn().mockReturnValue([SESION, REGISTRO, DOMINIOS]),
      listar: jest.fn().mockReturnValue(parametros),
      guardar: jest.fn().mockResolvedValue(undefined),
      recargar: jest.fn().mockResolvedValue(undefined),
    };
    const entorno = { describir: jest.fn().mockResolvedValue({ zona_horaria: 'America/Guayaquil', entorno: 'test' }) };
    const auditoria = { operacion: jest.fn().mockResolvedValue(undefined) };
    return { casos: casosConfiguracion({ repositorio, entorno, auditoria }), repositorio, auditoria, parametros };
  }

  const fallo = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as ErrorAplicacion; }
    throw new Error('se esperaba un error');
  };

  it('consultar: parámetros vigentes y datos del entorno', async () => {
    const { casos, parametros } = preparar();
    expect(await casos.consultar()).toEqual({ parametros, entorno: { zona_horaria: 'America/Guayaquil', entorno: 'test' } });
  });

  it.each([undefined, null, {}, [], 'sesion_horas=10'])('guardar: sin valores (%j) → 400 "No hay cambios para guardar."', async (valores) => {
    const { casos, repositorio } = preparar();
    const e = await fallo(casos.guardar(valores, ADMIN));
    expect(e.tipo).toBe('validacion');
    expect(e.message).toBe('No hay cambios para guardar.');
    expect(repositorio.guardar).not.toHaveBeenCalled();
  });

  it('guardar: una clave desconocida o un valor inválido rechazan todo el cambio sin escribir nada', async () => {
    const { casos, repositorio, auditoria } = preparar();
    const desconocida = await fallo(casos.guardar({ sesion_horas: '10', clave_rara: 'x' }, ADMIN));
    expect(desconocida.tipo).toBe('validacion');
    expect(desconocida.message).toBe('Parámetro desconocido: clave_rara');
    expect((await fallo(casos.guardar({ sesion_horas: '10', registro_publico_habilitado: 'quizás' }, ADMIN))).tipo).toBe('validacion');
    expect((await fallo(casos.guardar({ dominios_correo: 'ecu911.gob.ec,localhost' }, ADMIN))).tipo).toBe('validacion');
    expect(repositorio.guardar).not.toHaveBeenCalled();
    expect(auditoria.operacion).not.toHaveBeenCalled();
    expect(repositorio.recargar).not.toHaveBeenCalled();
  });

  it('guardar: escribe y audita solo lo que cambió (normalizado) y recarga la configuración', async () => {
    const { casos, repositorio, auditoria, parametros } = preparar();
    const r = await casos.guardar({ sesion_horas: '010', registro_publico_habilitado: 'true', dominios_correo: '@ECU911.gob.ec' }, ADMIN);
    expect(repositorio.guardar).toHaveBeenCalledTimes(1);
    expect(repositorio.guardar).toHaveBeenCalledWith('sesion_horas', '10', ADMIN.id);
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'CONFIGURACION', 'configuracion', null, 'sesion_horas: 8 → 10');
    expect(repositorio.recargar).toHaveBeenCalled();
    expect(r).toEqual({ cambiados: 1, parametros });
  });

  it('guardar sin cambios reales: no escribe ni audita, pero recarga y responde los parámetros', async () => {
    const { casos, repositorio, auditoria } = preparar();
    expect((await casos.guardar({ sesion_horas: '8' }, ADMIN)).cambiados).toBe(0);
    expect(repositorio.guardar).not.toHaveBeenCalled();
    expect(auditoria.operacion).not.toHaveBeenCalled();
    expect(repositorio.recargar).toHaveBeenCalled();
  });
});
