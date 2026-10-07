import { LOTE_RETENCION, repositorioAuditoriaSql } from '../../infraestructura/persistencia/auditoriaSql';
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
    expect(ultima().texto).toContain('FROM AuditoriaAccesos WHERE 1 = 1 AND exito = 0');
    await repositorioAuditoriaSql.contar({ ...SIN_FILTROS, fuente: 'cuentas', exito: true });
    expect(ultima().texto).not.toContain('exito');
  });

  it('pagina: mismas columnas resumidas del listado, más recientes primero', async () => {
    await repositorioAuditoriaSql.pagina({ ...SIN_FILTROS, fuente: 'cuentas' }, 50, 25);
    const { texto, entradas } = ultima();
    expect(texto).toContain('SELECT id, fecha, actor_email AS actor, accion, objetivo_email AS objetivo, detalle, ip FROM AuditoriaUsuarios');
    expect(texto).toContain('ORDER BY fecha DESC OFFSET @offset ROWS FETCH NEXT @tamano ROWS ONLY');
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

  it('retención: en cada tabla copia al archivo antes de borrar y borra solo lo copiado (o revierte todo)', () => {
    // El primer error corta el lote (CATCH lo devuelve) y archivar() revierte la transacción.
    // Sin SET XACT_ABORT: la opción quedaría activa en la conexión que el pool reutiliza.
    expect(LOTE_RETENCION).not.toMatch(/XACT_ABORT/i);
    expect(LOTE_RETENCION).toMatch(/BEGIN TRY[\s\S]*END TRY\s*BEGIN CATCH\s*THROW;\s*END CATCH;/);
    expect(LOTE_RETENCION).toContain('DATEADD(DAY, -@dias, SYSDATETIME())');
    expect(LOTE_RETENCION).not.toMatch(/\bUPDATE\b/i);
    for (const [tabla, archivo, conteo] of [
      ['AuditoriaOperaciones', 'AuditoriaOperacionesArchivo', 'operaciones'],
      ['AuditoriaUsuarios', 'AuditoriaUsuariosArchivo', 'cuentas'],
      ['AuditoriaAccesos', 'AuditoriaAccesosArchivo', 'accesos'],
    ]) {
      const copia = LOTE_RETENCION.indexOf(`INSERT INTO ${archivo} (`);
      const borrado = LOTE_RETENCION.indexOf(`DELETE t FROM ${tabla} t`);
      expect(copia).toBeGreaterThan(-1);
      expect(borrado).toBeGreaterThan(copia);
      expect(LOTE_RETENCION).toContain(`EXISTS (SELECT 1 FROM ${archivo} a WHERE a.id = t.id)`);
      expect(LOTE_RETENCION).toContain(`IF @@ROWCOUNT <> @${conteo} THROW`);
    }
    expect(LOTE_RETENCION.match(/\bDELETE\b/g)).toHaveLength(3);
    expect(LOTE_RETENCION).toMatch(/SELECT @operaciones AS operaciones, @cuentas AS cuentas, @accesos AS accesos;\s*$/);
  });

  describe('archivar: una sola transacción', () => {
    beforeEach(() => jest.clearAllMocks());

    it('abre la transacción, ejecuta el lote con @dias, confirma y devuelve los conteos como números', async () => {
      mockTransaccion.lote.mockResolvedValue({ recordset: [{ operaciones: 120, cuentas: '8', accesos: 950 }] });
      expect(await repositorioAuditoriaSql.archivar(730)).toEqual({ operaciones: 120, cuentas: 8, accesos: 950 });
      expect(mockTransaccion.lote).toHaveBeenCalledWith(LOTE_RETENCION, { dias: 730 });
      const orden = [mockTransaccion.begin, mockTransaccion.lote, mockTransaccion.commit].map(f => f.mock.invocationCallOrder[0]);
      expect(orden).toEqual([...orden].sort((a, b) => a - b));
      expect(mockTransaccion.rollback).not.toHaveBeenCalled();
    });

    it('si el lote falla, revierte todo (copia y borrado) y propaga el error sin confirmar', async () => {
      mockTransaccion.lote.mockRejectedValue(new Error('Retención de AuditoriaUsuarios: lo eliminado no coincide con lo archivado.'));
      await expect(repositorioAuditoriaSql.archivar(730)).rejects.toThrow('lo eliminado no coincide');
      expect(mockTransaccion.rollback).toHaveBeenCalledTimes(1);
      expect(mockTransaccion.commit).not.toHaveBeenCalled();
    });

    it('si falla el commit también revierte, y un rollback fallido no oculta el error original', async () => {
      mockTransaccion.lote.mockResolvedValue({ recordset: [{ operaciones: 1, cuentas: 0, accesos: 0 }] });
      mockTransaccion.commit.mockRejectedValueOnce(new Error('conexión perdida'));
      mockTransaccion.rollback.mockRejectedValueOnce(new Error('sin transacción'));
      await expect(repositorioAuditoriaSql.archivar(400)).rejects.toThrow('conexión perdida');
      expect(mockTransaccion.rollback).toHaveBeenCalledTimes(1);
    });
  });
});
