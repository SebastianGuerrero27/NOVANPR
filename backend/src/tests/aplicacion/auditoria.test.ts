import { casosAuditoria, type RepositorioAuditoria } from '../../aplicacion/auditoria';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import { celdaCsv, generarCsv, leerFiltrosAuditoria, MAX_FILAS_EXPORTACION } from '../../dominio/auditoria';

/** Casos de uso de la auditoría con dobles de prueba: sin base de datos, sin red. */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administrador', rol: 'Admin', ip: '10.0.0.1' };

const FILA_CUENTAS = {
  id: '7', fecha: new Date('2026-10-04T15:30:00Z'), accion: 'ROL_CAMBIADO', actor_id: 1, actor_email: 'admin@ecu911.gob.ec',
  objetivo_id: 3, objetivo_email: 'guardia@ecu911.gob.ec', detalle: '=HYPERLINK("http://malicioso", "clic")', ip: '10.0.0.1',
};

function preparar() {
  const repositorio: jest.Mocked<RepositorioAuditoria> = {
    contar: jest.fn().mockResolvedValue(42),
    pagina: jest.fn().mockResolvedValue([{ id: '7', accion: 'LISTA_ALTA' }]),
    completos: jest.fn().mockResolvedValue([FILA_CUENTAS, { ...FILA_CUENTAS, id: '8', detalle: 'Guardia, turno "noche"\nreasignado' }]),
    obtener: jest.fn().mockResolvedValue({ id: '7', accion: 'LISTA_ALTA' }),
    archivar: jest.fn().mockResolvedValue({ operaciones: 120, cuentas: 8, accesos: 950 }),
  };
  const auditoria = { operacion: jest.fn().mockResolvedValue(undefined) };
  const casos = casosAuditoria({ repositorio, auditoria, hoy: () => '2026-10-04' });
  return { casos, repositorio, auditoria };
}

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

describe('Casos de uso · auditoría', () => {
  it('consultar: mismos filtros y paginación del listado (tamaño de 10 a 100)', async () => {
    const { casos, repositorio } = preparar();
    const r = await casos.consultar({ fuente: 'accesos', q: '  pba ', resultado: 'fallo', pagina: '3', tamano: '500' });
    const filtros = { fuente: 'accesos', q: 'pba', desde: null, hasta: null, exito: false };
    expect(repositorio.contar).toHaveBeenCalledWith(filtros);
    expect(repositorio.pagina).toHaveBeenCalledWith(filtros, 200, 100);
    expect(r).toEqual({ items: [{ id: '7', accion: 'LISTA_ALTA' }], total: 42, pagina: 3, tamano: 100 });
  });

  it('filtros: fuente desconocida → operaciones; resultado solo para accesos; fechas inválidas se ignoran', () => {
    expect(leerFiltrosAuditoria({ fuente: 'toString', resultado: 'exito', desde: 'ayer', hasta: '2026-10-04T23:59:59' })).toEqual({
      fuente: 'operaciones', q: null, desde: null, hasta: new Date('2026-10-04T23:59:59'), exito: null,
    });
    expect(leerFiltrosAuditoria({ q: 'x'.repeat(150) }).q).toHaveLength(100);
  });

  it('CSV: comillas, comas y saltos de línea quedan dentro de la celda (RFC 4180)', () => {
    expect(celdaCsv('Guardia, turno "noche"\nreasignado')).toBe('"Guardia, turno ""noche""\nreasignado"');
    expect(celdaCsv(null)).toBe('""');
    expect(celdaCsv(undefined)).toBe('""');
    expect(celdaCsv(new Date('2026-10-04T15:30:00Z'))).toBe('"2026-10-04T15:30:00.000Z"');
    expect(celdaCsv(true)).toBe('"true"');
    expect(celdaCsv(15)).toBe('"15"');
  });

  it.each(['=1+1', '+5551234', '-2+3', '@SUM(A1:A9)', '\t=1', '\r=1', '=HYPERLINK("http://x")'])(
    'CSV: neutraliza la inyección de fórmulas en %j con un apóstrofo', (valor) => {
      expect(celdaCsv(valor)).toBe(`"'${valor.replace(/"/g, '""')}"`);
    });

  it('CSV: no altera textos que no empiezan como fórmula', () => {
    expect(celdaCsv('a=b')).toBe('"a=b"');
    expect(celdaCsv('LISTA_ALTA')).toBe('"LISTA_ALTA"');
    expect(celdaCsv("O'Brien")).toBe('"O\'Brien"');
  });

  it('generarCsv: encabezado con las columnas y una línea CRLF por registro', () => {
    expect(generarCsv(['id', 'detalle'], [{ id: 1, detalle: 'a,b' }, { id: 2, detalle: null }]))
      .toBe('"id","detalle"\r\n"1","a,b"\r\n"2",""\r\n');
  });

  it('exportar: columnas completas, máximo 50 000 registros, nombre con fuente y fecha, y queda auditado', async () => {
    const { casos, repositorio, auditoria } = preparar();
    const r = await casos.exportar({ fuente: 'cuentas', q: 'admin' }, ADMIN);
    expect(MAX_FILAS_EXPORTACION).toBe(50000);
    expect(repositorio.completos).toHaveBeenCalledWith(expect.objectContaining({ fuente: 'cuentas', q: 'admin' }), 50000);
    expect(r.nombre).toBe('auditoria_cuentas_2026-10-04.csv');
    expect(r.registros).toBe(2);
    const lineas = r.contenido.split('\r\n');
    expect(lineas[0]).toBe('"id","fecha","accion","actor_id","actor_email","objetivo_id","objetivo_email","detalle","ip"');
    expect(lineas[1]).toBe('"7","2026-10-04T15:30:00.000Z","ROL_CAMBIADO","1","admin@ecu911.gob.ec","3","guardia@ecu911.gob.ec",'
      + '"\'=HYPERLINK(""http://malicioso"", ""clic"")","10.0.0.1"');
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'AUDITORIA_EXPORTADA', 'auditoria', null, 'cuentas · 2 registros · texto "admin"');
  });

  it('exportar: el texto de búsqueda se audita sin saltos de línea ni caracteres de control', async () => {
    const { casos, auditoria } = preparar();
    await casos.exportar({ fuente: 'cuentas', q: 'x\r\nAUDITORIA_RETENCION · otro\u0007' }, ADMIN);
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'AUDITORIA_EXPORTADA', 'auditoria', null,
      'cuentas · 2 registros · texto "x AUDITORIA_RETENCION · otro"');
  });

  it('obtener: valida fuente e identificador y responde 404 si no existe', async () => {
    const { casos, repositorio } = preparar();
    await casos.obtener('OPERACIONES', '7');
    expect(repositorio.obtener).toHaveBeenCalledWith('operaciones', 7);
    expect((await fallo(casos.obtener('sistema', '7'))).tipo).toBe('validacion');
    expect((await fallo(casos.obtener('cuentas', '0'))).tipo).toBe('validacion');
    expect((await fallo(casos.obtener('cuentas', '7a'))).tipo).toBe('validacion');
    repositorio.obtener.mockResolvedValue(null);
    expect((await fallo(casos.obtener('accesos', '99'))).tipo).toBe('no_encontrado');
  });

  it.each([undefined, '', 30, 364, 3651, '400.5', 'un año', '1e3', true])(
    'retención: rechaza %j (mínimo 365 días, máximo 3650) sin tocar la base', async (dias) => {
      const { casos, repositorio, auditoria } = preparar();
      expect((await fallo(casos.aplicarRetencion(dias, ADMIN))).tipo).toBe('validacion');
      expect(repositorio.archivar).not.toHaveBeenCalled();
      expect(auditoria.operacion).not.toHaveBeenCalled();
    });

  it('retención: archiva, devuelve los conteos y deja constancia en la auditoría', async () => {
    const { casos, repositorio, auditoria } = preparar();
    expect(await casos.aplicarRetencion('730', ADMIN)).toEqual({ archivados: { operaciones: 120, cuentas: 8, accesos: 950 } });
    expect(repositorio.archivar).toHaveBeenCalledWith(730);
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'AUDITORIA_RETENCION', 'auditoria', null,
      'Registros con más de 730 días archivados: 120 operaciones, 8 cuentas, 950 accesos');
    await casos.aplicarRetencion(365, ADMIN);
    await casos.aplicarRetencion(3650, ADMIN);
    expect(repositorio.archivar).toHaveBeenLastCalledWith(3650);
  });

  it('inmutabilidad: los casos de uso no ofrecen editar ni borrar registros', () => {
    expect(Object.keys(preparar().casos).sort()).toEqual(['aplicarRetencion', 'consultar', 'exportar', 'obtener']);
  });
});
