import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import sql from 'mssql';
import { cargarConfiguracion } from '../services/configuracion';
import fs from 'fs';
import path from 'path';

const isDocker = process.env.DOCKER_CONTAINER === 'true';
const defaultDbHost = isDocker ? 'db' : '127.0.0.1';
const defaultDbPort = isDocker ? 1433 : 14333;
const NOMBRE_BD = process.env.DB_NAME || 'ANPR_ECU911';

const base = (database: string): sql.config => ({
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || defaultDbHost,
  port: parseInt(process.env.DB_PORT || String(defaultDbPort)),
  database,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    max: Number(process.env.DB_POOL_MAX || 10),
    min: 0,
    idleTimeoutMillis: 30000,
  },
});

/**
 * Migraciones en orden de aplicación. Todas son idempotentes (IF NOT EXISTS / COL_LENGTH),
 * pero además se registran en SchemaMigraciones con su suma SHA-256: una migración ya
 * aplicada no se vuelve a ejecutar en cada arranque, y si su archivo cambia se ejecuta de
 * nuevo y se registra la nueva suma (trazabilidad del esquema, al estilo de Flyway).
 */
export const MIGRACIONES = [
  'migration_deteccion_vehiculo.sql',
  'migration_camaras_ping.sql',
  'migration_deteccion_tipo_vehiculo.sql',
  'migration_placa_varchar20.sql',
  'migration_fuente_varchar255.sql',
  'migration_auditoria_descartes.sql',
  'migration_evaluacion.sql',
  'migration_vehiculo_atributos.sql',
  'migration_auditoria_propietario.sql',
  'migration_v2_seguridad.sql',
  'migration_v3_operacion.sql',
  'migration_v4_lectura_valida.sql',
  'migration_v5_accesos_notificaciones.sql',
];

let pool: sql.ConnectionPool;

export async function connectDB(): Promise<sql.ConnectionPool> {
  const maxRetries = 10;
  const delay = 5000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`[DB] Intentando conectar a SQL Server (Intento ${i + 1}/${maxRetries})...`);
      await asegurarBaseDeDatos();

      // Todo el esquema se aplica con un pool conectado a la base de destino. Antes se ejecutaba
      // sobre la conexión a master confiando en que el `USE` de init.sql persistiera en la misma
      // conexión del pool, lo que no está garantizado.
      pool = await new sql.ConnectionPool(base(NOMBRE_BD)).connect();
      console.log(`[DB] Conectado a la base de datos principal: ${NOMBRE_BD}`);
      await initDatabaseSchema();

      await verificarConfiguracionInicial();
      await cargarConfiguracion(pool);

      return pool;
    } catch (err: any) {
      console.error(`[DB] Error en conexión: ${err.message}. Reintentando en ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('[DB] No se pudo conectar a SQL Server después de múltiples intentos.');
}

/** Crea la base si no existe (única operación que necesita la conexión a master). */
async function asegurarBaseDeDatos() {
  const master = await new sql.ConnectionPool(base('master')).connect();
  try {
    await master.request().input('n', sql.NVarChar(128), NOMBRE_BD).query(`
      IF DB_ID(@n) IS NULL BEGIN
        DECLARE @s NVARCHAR(300) = N'CREATE DATABASE ' + QUOTENAME(@n);
        EXEC (@s);
      END`);
  } finally {
    await master.close();
  }
}

function rutaScript(nombre: string): string | null {
  const candidatos = [path.join(__dirname, '../../../db', nombre), path.join(__dirname, '../../db', nombre)];
  return candidatos.find(c => fs.existsSync(c)) ?? null;
}

/**
 * Lotes de un script T-SQL separados por GO (en su propia línea, como hace sqlcmd). Se quitan
 * las sentencias USE y el lote de CREATE DATABASE: la conexión ya apunta a la base de destino
 * (lo que además permite usar un DB_NAME distinto de ANPR_ECU911).
 */
export function lotesSql(script: string): string[] {
  return script
    .split(/^\s*GO\s*;?\s*$/gim)
    .map(lote => lote.replace(/^\s*USE\s+\[?\w+\]?\s*;?\s*$/gim, '').trim())
    .filter(lote => {
      const sentencias = lote.replace(/^\s*--.*$/gm, '').trim();
      return sentencias.length > 0 && !/^IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+\*\s+FROM\s+sys\.databases/i.test(sentencias);
    });
}

async function ejecutarScript(nombre: string): Promise<boolean> {
  const ruta = rutaScript(nombre);
  if (!ruta) {
    console.log(`[DB] Script ${nombre} no encontrado. Omitiendo.`);
    return false;
  }
  const contenido = fs.readFileSync(ruta, 'utf8');
  for (const lote of lotesSql(contenido)) await pool.request().batch(lote);
  return true;
}

async function initDatabaseSchema() {
  try {
    console.log('[DB] Aplicando init.sql…');
    await ejecutarScript('init.sql');

    await pool.request().batch(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SchemaMigraciones')
        CREATE TABLE SchemaMigraciones (
          nombre          VARCHAR(120) NOT NULL PRIMARY KEY,
          suma_sha256     CHAR(64)     NOT NULL,
          fecha_aplicada  DATETIME2    NOT NULL DEFAULT SYSDATETIME()
        );`);
    const aplicadas = new Map<string, string>(
      (await pool.request().query('SELECT nombre, suma_sha256 FROM SchemaMigraciones')).recordset.map(r => [r.nombre, r.suma_sha256]),
    );

    for (const nombre of MIGRACIONES) await runMigration(nombre, aplicadas);
    console.log('[DB] Esquema actualizado.');
  } catch (error: any) {
    console.error('[DB] Error al inicializar el esquema de base de datos:', error.message);
  }
}

async function runMigration(nombre: string, aplicadas: Map<string, string>) {
  const ruta = rutaScript(nombre);
  if (!ruta) {
    console.log(`[DB] Migración ${nombre} no encontrada. Omitiendo.`);
    return;
  }
  const suma = crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
  if (aplicadas.get(nombre) === suma) return;
  try {
    console.log(`[DB] Ejecutando migración: ${nombre}...`);
    await ejecutarScript(nombre);
    await pool.request().input('n', sql.VarChar(120), nombre).input('s', sql.Char(64), suma).query(`
      MERGE SchemaMigraciones AS t USING (SELECT @n AS nombre) AS s ON t.nombre = s.nombre
      WHEN MATCHED THEN UPDATE SET suma_sha256 = @s, fecha_aplicada = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (nombre, suma_sha256) VALUES (@n, @s);`);
    console.log(`[DB] Migración ${nombre} completada con éxito.`);
  } catch (error: any) {
    // No se registra: se reintentará en el próximo arranque
    console.error(`[DB] Error en migración ${nombre}:`, error.message);
  }
}

/**
 * Sin datos de siembra: el sistema no precarga usuarios, placas ni cámaras ficticias.
 * Solo informa si falta crear el primer administrador (pantalla de configuración inicial).
 */
async function verificarConfiguracionInicial() {
  try {
    const r = await pool.request().query(`
      SELECT COUNT(*) AS n FROM Usuarios u JOIN Roles r ON r.id = u.rol_id WHERE r.codigo = 'ADMIN'`);
    if (r.recordset[0].n === 0) {
      console.log('[DB] No hay administradores: abra el sistema y complete la configuración inicial para crear el primero.');
    }
  } catch (error: any) {
    console.error('[DB] No se pudo verificar la configuración inicial:', error.message);
  }
}

export function getDB(): sql.ConnectionPool {
  if (!pool) {
    throw new Error('[DB] Pool de base de datos no inicializado.');
  }
  return pool;
}
