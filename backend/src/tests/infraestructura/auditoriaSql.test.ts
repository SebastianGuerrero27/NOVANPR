import { repositorioAuditoriaSql } from '../../infraestructura/persistencia/auditoriaSql';
import type { FiltrosAuditoria } from '../../dominio/auditoria';

/**
 * Repositorio SQL de la auditoría con la base simulada: los filtros viajan como parámetros y la
 * retención copia al archivo antes de borrar, y borra solo lo copiado (registro inmutable).
 */
const mockConsultas: { texto: string; entradas: Record<string, unknown> }[] = [];

jest.mock('../../infraestructura/db', () => ({
  getDB: () => ({
    request: () => {
      const entradas: Record<string, unknown> = {};
      const r: any = {
        input: (nombre: string, _tipo: unknown, valor: unknown) => { entradas[nombre] = valor; return r; },
        query: async (texto: string) => { mockConsultas.push({ texto, entradas }); return { recordset: [{ n: 3, id: '7' }] }; },
      };
      return r;
    },
  }),
}));

/** Transacción simulada de mssql: registra begin, el lote ejecutado, commit y rollback. */
const mockTransaccion = {
  begin: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  lote: jest.fn(),
};

jest.mock('mssql', () => {
  const real = jest.requireActual('mssql');
  class Transaction {
    begin = () => mockTransaccion.begin();
    commit = () => mockTransaccion.commit();
    rollback = () => mockTransaccion.rollback();
  }
  class Request {
    private readonly entradas: Record<string, unknown> = {};
    input(nombre: string, _tipo: unknown, valor: unknown) { this.entradas[nombre] = valor; return this; }
    query(texto: string) { return mockTransaccion.lote(texto, this.entradas); }
  }
  return { ...real, Transaction, Request };
});

const SIN_FILTROS: FiltrosAuditoria = { fuente: 'operaciones', q: null, desde: null, hasta: null, exito: null };
const ultima = () => mockConsultas[mockConsultas.length - 1];

describe('Repositorio SQL · auditoría', () => {
  it('el texto buscado y las fechas viajan como parámetros, nunca dentro del SQL', async () => {
    const desde = new Date('2026-10-01T05:00:00Z');
    expect(await repositorioAuditoriaSql.contar({ ...SIN_FILTROS, q: "x' OR 1=1 --", desde })).toBe(3);
    const { texto, entradas } = ultima();
    expect(texto).toContain('FROM AuditoriaOperaciones');
    expect(texto).toContain('usuario_email LIKE @q');
    expect(texto).toContain('fecha >= @desde');
    expect(texto).not.toContain('OR 1=1');
    expect(entradas).toEqual({ q: "%x' OR 1=1 --%", desde });
  });

  it('el filtro de resultado solo se aplica a los inicios de sesión', async () => {
    await repositorioAuditoriaSql.contar({ ...SIN_FILTROS, fuente: 'accesos', exito: false });
    expect(ultima().texto).toContain('FROM AuditoriaAccesos WHERE 1 = 1 AND exito IS FALSE');
    await repositorioAuditoriaSql.contar({ ...SIN_FILTROS, fuente: 'cuentas', exito: true });
    expect(ultima().texto).not.toContain('exito');
  });

  it('pagina: mismas columnas resumidas del listado, más recientes primero', async () => {
    await repositorioAuditoriaSql.pagina({ ...SIN_FILTROS, fuente: 'cuentas' }, 50, 25);
    const { texto, entradas } = ultima();
    expect(texto).toContain('SELECT id, fecha, actor_email AS actor, accion, objetivo_email AS objetivo, detalle, ip FROM AuditoriaUsuarios');
    expect(texto).toContain('ORDER BY fecha DESC LIMIT @tamano OFFSET @offset');
    expect(entradas).toEqual({ offset: 50, tamano: 25 });
  });

  it('completos: todas las columnas de la fuente con un límite parametrizado', async () => {
    await repositorioAuditoriaSql.completos({ ...SIN_FILTROS, fuente: 'accesos' }, 50000);
    const { texto, entradas } = ultima();
    expect(texto).toContain('SELECT TOP (@limite) id, fecha, email, usuario_id, exito, motivo, ip, user_agent FROM AuditoriaAccesos');
    expect(texto).toContain('ORDER BY fecha DESC, id DESC');
    expect(entradas.limite).toBe(50000);
  });

  it('obtener: un registro por id', async () => {
    expect(await repositorioAuditoriaSql.obtener('operaciones', 7)).toEqual({ n: 3, id: '7' });
    expect(ultima().texto).toMatch(/FROM AuditoriaOperaciones WHERE id = @id$/);
    expect(ultima().entradas.id).toBe(7);
  });

});
