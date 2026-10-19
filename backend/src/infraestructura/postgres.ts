import { Pool, PoolClient, QueryResult } from 'pg';

type Parametro = { valor: unknown };

/** Compatibilidad temporal de la API de peticiones mientras los repositorios migran a SQL PG. */
export class PostgresPool extends Pool {
  request(): PostgresRequest { return new PostgresRequest(this); }
  get connected(): boolean { return true; }
}
export type ConnectionPool = PostgresPool;

export class PostgresTransaction {
  private client?: PoolClient;
  constructor(private readonly pool: PostgresPool) {}
  async begin(nivel?: number): Promise<void> { this.client = await this.pool.connect(); await this.client.query('BEGIN'); if (nivel === 1) await this.client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'); }
  async commit(): Promise<void> { if (this.client) { await this.client.query('COMMIT'); this.client.release(); this.client = undefined; } }
  async rollback(): Promise<void> { if (this.client) { try { await this.client.query('ROLLBACK'); } finally { this.client.release(); this.client = undefined; } } }
  request(): PostgresRequest { if (!this.client) throw new Error('Transacción PostgreSQL no iniciada'); return new PostgresRequest(this.client); }
}

export class PostgresRequest {
  private readonly parametros = new Map<string, Parametro>();
  constructor(private readonly ejecutor: PostgresPool | PoolClient | PostgresTransaction) {}
  input(nombre: string, _tipo: unknown, valor?: unknown): this {
    if (arguments.length === 2) { valor = _tipo; }
    this.parametros.set(nombre, { valor });
    return this;
  }
  async query(consulta: string): Promise<{ recordset: any[]; recordsets: any[][]; rowsAffected: number[] }> {
    const { text, values } = prepararConsulta(consulta, this.parametros);
    const sentencias = separarSentencias(text);
    const resultados: QueryResult[] = [];
    for (const sentencia of sentencias) {
      const { sql, args } = remapearParametros(sentencia, values);
      const executor = this.ejecutor instanceof PostgresTransaction ? this.ejecutor.request() : this.ejecutor;
      resultados.push(await (executor as Pool | PoolClient).query(sql, args));
    }
    const ultimo = resultados.at(-1);
    const filas = [...resultados].reverse().find(x => x.rows?.length)?.rows ?? [];
    return { recordset: filas, recordsets: resultados.filter(x => x.rows?.length).map(x => x.rows), rowsAffected: [resultados.reduce((n, x) => n + (x.rowCount ?? 0), 0)], ...(ultimo ? {} : {}) };
  }
  async batch(consulta: string): Promise<{ recordset: any[]; recordsets: any[][]; rowsAffected: number[] }> {
    return this.query(consulta);
  }
}

function adaptarResultado(resultado: QueryResult): { recordset: any[]; recordsets: any[][]; rowsAffected: number[] } {
  const filas = resultado.rows ?? [];
  return { recordset: filas, recordsets: [filas], rowsAffected: [resultado.rowCount ?? 0] };
}

/** Convierte placeholders @nombre a parámetros posicionales de node-postgres. */
function prepararConsulta(consulta: string, parametros: Map<string, Parametro>): { text: string; values: unknown[] } {
  const valores: unknown[] = [];
  const indices = new Map<string, number>();
  const text = traducirTsqlBasico(consulta).replace(/@([a-zA-Z_][\w]*)/g, (_m, nombre: string) => {
    if (!parametros.has(nombre)) throw new Error(`Parámetro SQL no definido: @${nombre}`);
    if (!indices.has(nombre)) { valores.push(parametros.get(nombre)!.valor); indices.set(nombre, valores.length); }
    return `$${indices.get(nombre)}`;
  });
  return { text, values: valores };
}

/** Traducciones mecánicas seguras; las consultas T-SQL complejas se portan en sus módulos. */
function traducirTsqlBasico(consulta: string): string {
  let q = consulta
    .replace(/\bSYSDATETIME\(\)|\bGETDATE\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\bNVARCHAR\s*\(\s*MAX\s*\)/gi, 'TEXT')
    .replace(/\bNVARCHAR\s*\(\s*\d+\s*\)/gi, m => `VARCHAR${m.slice(m.indexOf('('))}`)
    .replace(/\bDATETIME2?(?:\s*\(\s*\d+\s*\))?/gi, 'TIMESTAMP')
    .replace(/\bBIT\b/gi, 'BOOLEAN')
    .replace(/WITH\s*\(\s*UPDLOCK\s*,\s*HOLDLOCK\s*\)/gi, '')
    .replace(/\bLEN\s*\(/gi, 'LENGTH(');
  q = reemplazarFuncion(q, 'DATEADD', args => {
    const [unidad, cantidad, fecha] = args;
    const u = unidad.trim().toLowerCase();
    const unidadPg: Record<string, string> = { day: 'day', hour: 'hour', minute: 'minute', second: 'second', millisecond: 'millisecond' };
    const cantidadNumerica = cantidad.replace(/@([a-zA-Z_]\w*)/g, '@$1::double precision');
    return unidadPg[u] ? `(${fecha} + ((${cantidadNumerica}) * INTERVAL '1 ${unidadPg[u]}'))` : `DATEADD(${args.join(',')})`;
  });
  q = reemplazarFuncion(q, 'DATEPART', args => args.length === 2 ? `EXTRACT(${args[0].toUpperCase()} FROM ${args[1]})` : `DATEPART(${args.join(',')})`);
  q = reemplazarFuncion(q, 'DATEDIFF_BIG', args => args[0]?.trim().toLowerCase() === 'millisecond' ? `(EXTRACT(EPOCH FROM (${args[2]} - ${args[1]})) * 1000)` : `DATEDIFF_BIG(${args.join(',')})`);
  q = reemplazarFuncion(q, 'DATEDIFF', args => args[0]?.trim().toLowerCase() === 'minute' ? `(EXTRACT(EPOCH FROM (${args[2]} - ${args[1]})) / 60)` : `DATEDIFF(${args.join(',')})`);
  q = q.replace(/CAST\((CASE\s+WHEN[\s\S]*?END)\s+AS\s+BOOLEAN\)/gi, (_m, expr: string) => `(${expr.replace(/THEN\s+1\s+ELSE\s+0/gi, 'THEN TRUE ELSE FALSE')})`);
  q = q.replace(/CAST\((0|1)\s+AS\s+BOOLEAN\)/gi, (_m, v: string) => v === '1' ? 'TRUE' : 'FALSE');
  q = q.replace(/\bSET\s+((?:\w+\.)?(?:activo|activa|usado|exito|bloqueado|requiere_ack|escalada|validado_manualmente|lectura_valida|email_verificado))\s*=\s*1\b/gi, 'SET $1 = TRUE')
    .replace(/\bSET\s+((?:\w+\.)?(?:activo|activa|usado|exito|bloqueado|requiere_ack|escalada|validado_manualmente|lectura_valida|email_verificado))\s*=\s*0\b/gi, 'SET $1 = FALSE')
    .replace(/\b(?:\w+\.)?(activo|activa|usado|exito|bloqueado|requiere_ack|escalada|validado_manualmente|lectura_valida|email_verificado)\s*=\s*1\b/gi, '$1 = TRUE')
    .replace(/\b(?:\w+\.)?(activo|activa|usado|exito|bloqueado|requiere_ack|escalada|validado_manualmente|lectura_valida|email_verificado)\s*=\s*0\b/gi, '$1 = FALSE')
    .replace(/(@\w+)\s*=\s*1\b/g, '$1 = TRUE').replace(/(@\w+)\s*=\s*0\b/g, '$1 = FALSE');
  const salida = q.match(/\bOUTPUT\s+(?:(INSERTED|DELETED)\.)?([\w.]+(?:\s*,\s*(?:(?:INSERTED|DELETED)\.)?[\w.]+)*)/i);
  if (salida) {
    const columnas = salida[2].split(',').map(c => c.trim().replace(/^(?:INSERTED|DELETED)\./i, '')).join(', ');
    q = `${q.slice(0, salida.index)}${q.slice((salida.index ?? 0) + salida[0].length)}`.trim();
    q = q.replace(/;$/, '').replace(/\s+$/, '') + ` RETURNING ${columnas}`;
  }
  if (/^\s*DELETE\s+\w+\s+FROM\s+/i.test(q)) q = q.replace(/^\s*DELETE\s+\w+\s+FROM\s+/i, 'DELETE FROM ');
  q = convertirTop(q);
  return q;
}

/** Convierte cada SELECT TOP en LIMIT dentro de su propio nivel de subconsulta/UNION. */
function convertirTop(consulta: string): string {
  let q = consulta;
  const marcadores: { token: string; profundidad: number; limite: string }[] = [];
  const re = /\bSELECT\s+(?:DISTINCT\s+)?TOP\s*(?:\(\s*(@\w+)\s*\)|(\d+))\s*/ig;
  let m: RegExpExecArray | null;
  let ordinal = 0;
  while ((m = re.exec(q))) {
    const token = `__PG_TOP_${ordinal++}__`;
    const antes = q.slice(0, m.index);
    const profundidad = (antes.match(/\(/g)?.length ?? 0) - (antes.match(/\)/g)?.length ?? 0);
    const distinct = /^SELECT\s+DISTINCT\s+/i.test(m[0]) ? 'SELECT DISTINCT ' : 'SELECT ';
    const limite = m[1] ?? m[2];
    q = q.slice(0, m.index) + `${distinct}${token} ` + q.slice(re.lastIndex);
    re.lastIndex = m.index + distinct.length + token.length + 1;
    marcadores.push({ token, profundidad, limite });
  }
  for (const { token, profundidad, limite } of marcadores) {
    const inicio = q.indexOf(token);
    if (inicio < 0) continue;
    const tail = q.slice(inicio + token.length);
    let depth = profundidad;
    let quote = false;
    let fin = q.length;
    for (let i = 0; i < tail.length; i++) {
      const c = tail[i];
      if (c === "'") { if (quote && tail[i + 1] === "'") { i++; continue; } quote = !quote; continue; }
      if (quote) continue;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === profundidad) { fin = inicio + token.length + i; break; } depth--; }
      else if (depth === profundidad && /;/.test(c)) { fin = inicio + token.length + i; break; }
      else if (depth === profundidad && /^\s+UNION(?:\s+ALL)?\b/i.test(tail.slice(i))) { fin = inicio + token.length + i; break; }
    }
    q = q.slice(0, fin).trimEnd() + ` LIMIT ${limite}` + q.slice(fin);
    q = q.replace(token, '');
  }
  return q;
}

function reemplazarFuncion(sql: string, nombre: string, transformar: (args: string[]) => string): string {
  const re = new RegExp(`\\b${nombre}\\s*\\(`, 'i');
  let resultado = sql;
  for (;;) {
    const m = re.exec(resultado);
    if (!m) return resultado;
    const inicio = m.index;
    let i = inicio + m[0].length, profundidad = 1, comilla = false, args: string[] = [], parte = i;
    for (; i < resultado.length && profundidad; i++) {
      const c = resultado[i];
      if (c === "'") { if (comilla && resultado[i + 1] === "'") { i++; continue; } comilla = !comilla; }
      else if (!comilla && c === '(') profundidad++;
      else if (!comilla && c === ')') { profundidad--; if (!profundidad) args.push(resultado.slice(parte, i)); }
      else if (!comilla && c === ',' && profundidad === 1) { args.push(resultado.slice(parte, i)); parte = i + 1; }
    }
    if (profundidad) return resultado;
    resultado = resultado.slice(0, inicio) + transformar(args) + resultado.slice(i);
  }
}

function separarSentencias(text: string): string[] { return text.split(';').map(s => s.trim()).filter(Boolean); }
function remapearParametros(text: string, values: unknown[]): { sql: string; args: unknown[] } {
  const args: unknown[] = [], ix = new Map<number, number>();
  const sql = text.replace(/\$(\d+)/g, (_m, s: string) => {
    const original = Number(s);
    if (!ix.has(original)) { args.push(values[original - 1]); ix.set(original, args.length); }
    return `$${ix.get(original)}`;
  });
  return { sql, args };
}

const tipo = (nombre: string) => (_longitud?: number) => nombre;
const sql = {
  Int: 'INTEGER', BigInt: 'BIGINT', Float: 'DOUBLE PRECISION', Bit: 'BOOLEAN', Date: 'DATE',
  DateTime: 'TIMESTAMP', DateTime2: 'TIMESTAMP', MAX: -1,
  VarChar: tipo('VARCHAR'), NVarChar: tipo('VARCHAR'), Char: tipo('CHAR'),
  ConnectionPool: PostgresPool, Transaction: PostgresTransaction, Request: PostgresRequest,
  ISOLATION_LEVEL: { SERIALIZABLE: 1 },
};

export default sql;
