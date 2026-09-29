import dotenv from 'dotenv';
dotenv.config();

import sql from 'mssql';
import { cargarConfiguracion } from '../services/configuracion';
import fs from 'fs';
import path from 'path';

const isDocker = process.env.DOCKER_CONTAINER === 'true';
const defaultDbHost = isDocker ? 'db' : '127.0.0.1';
const defaultDbPort = isDocker ? 1433 : 14333;

const config: sql.config = {
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || defaultDbHost,
  port: parseInt(process.env.DB_PORT || String(defaultDbPort)),
  database: 'master', // Inicialmente conectamos a master para poder crear la DB si no existe
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

let pool: sql.ConnectionPool;

export async function connectDB(): Promise<sql.ConnectionPool> {
  const maxRetries = 10;
  let delay = 5000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`[DB] Intentando conectar a SQL Server (Intento ${i + 1}/${maxRetries})...`);
      pool = await new sql.ConnectionPool(config).connect();
      console.log('[DB] Conexión establecida con master.');

      // Inicializar base de datos y tablas
      await initDatabaseSchema();

      // Reconectamos el pool a la base de datos específica
      await pool.close();
      config.database = process.env.DB_NAME || 'ANPR_ECU911';
      pool = await new sql.ConnectionPool(config).connect();
      console.log(`[DB] Conectado exitosamente a la base de datos principal: ${config.database}`);

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

async function initDatabaseSchema() {
  try {
    // Intentamos leer el archivo init.sql que mapeamos en el contenedor o buscamos una ruta local
    let sqlScriptPath = path.join(__dirname, '../../../db/init.sql');
    if (!fs.existsSync(sqlScriptPath)) {
      sqlScriptPath = path.join(__dirname, '../../db/init.sql');
    }

    if (!fs.existsSync(sqlScriptPath)) {
      console.warn(`[DB] No se encontró el archivo init.sql en ${sqlScriptPath}. Se omitirá inicialización automática de esquema.`);
      return;
    }

    console.log('[DB] Leyendo init.sql para la inicialización del esquema...');
    const fullScript = fs.readFileSync(sqlScriptPath, 'utf8');

    // SQL Server mssql no permite correr scripts completos con GO en un solo query.
    // Separamos el script por 'GO' para ejecutar cada comando individualmente.
    const commands = fullScript
      .split(/\bGO\b/i)
      .map(cmd => cmd.trim())
      .filter(cmd => cmd.length > 0);

    const request = pool.request();
    for (const command of commands) {
      await request.query(command);
    }
    console.log('[DB] Inicialización del esquema completada con éxito.');

    // Ejecutar migraciones adicionales (si existen)
    await runMigration('migration_deteccion_vehiculo.sql');
    await runMigration('migration_camaras_ping.sql');
    await runMigration('migration_deteccion_tipo_vehiculo.sql');
    await runMigration('migration_placa_varchar20.sql');
    await runMigration('migration_fuente_varchar255.sql');
    await runMigration('migration_auditoria_descartes.sql');
    await runMigration('migration_evaluacion.sql');
    await runMigration('migration_vehiculo_atributos.sql');
    await runMigration('migration_auditoria_propietario.sql');
    await runMigration('migration_v2_seguridad.sql');
    await runMigration('migration_v3_operacion.sql');
    await runMigration('migration_v4_lectura_valida.sql');
  } catch (error: any) {
    console.error('[DB] Error al inicializar el esquema de base de datos:', error.message);
  }
}

async function runMigration(filename: string) {
  try {
    let migrationPath = path.join(__dirname, '../../../db', filename);
    if (!fs.existsSync(migrationPath)) {
      migrationPath = path.join(__dirname, '../../db', filename);
    }

    if (!fs.existsSync(migrationPath)) {
      console.log(`[DB] Migración ${filename} no encontrada. Omitiendo.`);
      return;
    }

    console.log(`[DB] Ejecutando migración: ${filename}...`);
    const fullScript = fs.readFileSync(migrationPath, 'utf8');
    const commands = fullScript
      .split(/\bGO\b/i)
      .map(cmd => cmd.trim())
      .filter(cmd => cmd.length > 0);

    const request = pool.request();
    for (const command of commands) {
      await request.query(command);
    }
    console.log(`[DB] Migración ${filename} completada con éxito.`);
  } catch (error: any) {
    console.error(`[DB] Error en migración ${filename}:`, error.message);
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
