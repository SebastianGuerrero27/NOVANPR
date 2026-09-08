import dotenv from 'dotenv';
dotenv.config();

import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';

const isDocker = process.env.DOCKER_CONTAINER === 'true';
const defaultDbHost = isDocker ? 'db' : '127.0.0.1';
const defaultDbPort = isDocker ? 1433 : 14333;

const config: sql.config = {
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD || 'SecurePassword123!',
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

      // Sembrar datos (usuarios por defecto)
      await seedDatabase();

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

async function seedDatabase() {
  try {
    const request = pool.request();
    // Validar si ya existen usuarios
    const checkUsers = await request.query('SELECT COUNT(*) as count FROM Usuarios');
    const userCount = checkUsers.recordset[0].count;

    if (userCount === 0) {
      console.log('[DB] Sembrando usuarios por defecto (admin y operador)...');
      
      const adminPassHash = await bcrypt.hash('PasswordAdmin123!', 10);
      const operatorPassHash = await bcrypt.hash('PasswordOperator123!', 10);

      await request
        .input('adminHash', sql.VarChar, adminPassHash)
        .query(`
          INSERT INTO Usuarios (username, password_hash, nombre, rol, activo)
          VALUES ('admin', @adminHash, 'Administrador ECU 911', 'Admin', 1)
        `);

      await request
        .input('opHash', sql.VarChar, operatorPassHash)
        .query(`
          INSERT INTO Usuarios (username, password_hash, nombre, rol, activo)
          VALUES ('operator', @opHash, 'Operador Zona 3', 'Operador', 1)
        `);
      
      console.log('[DB] Usuarios por defecto sembrados (admin / operator).');
    }

    // Sembrar placa de prueba en lista negra si está vacía
    const checkBlacklist = await request.query('SELECT COUNT(*) as count FROM ListaNegra');
    if (checkBlacklist.recordset[0].count === 0) {
      console.log('[DB] Sembrando datos de prueba en Lista Negra...');
      await request.query(`
        INSERT INTO ListaNegra (placa, motivo, nivel_alerta, activo)
        VALUES 
        ('PBA-1234', 'Vehículo reportado por robo en Ambato', 'CRITICA', 1),
        ('TBG-987', 'Vehículo sospechoso involucrado en asalto', 'ALTA', 1)
      `);
      console.log('[DB] Placas de prueba sembradas en Lista Negra.');
    }

    // Sembrar vehículos autorizados si la tabla existe y está vacía
    try {
      const checkWhitelist = await request.query('SELECT COUNT(*) as count FROM VehiculosAutorizados');
      if (checkWhitelist.recordset[0].count === 0) {
        console.log('[DB] Sembrando datos de prueba en VehiculosAutorizados...');
        await pool.request().query(`
          INSERT INTO VehiculosAutorizados (placa, propietario, departamento, tipo_vehiculo, activo)
          VALUES 
          ('PBA5678', 'Coordinación Zonal 3 - ECU 911', 'Dirección', 'Institucional', 1),
          ('TCA9012', 'Ing. Carlos Medina', 'Operaciones', 'Funcionario', 1),
          ('ABC999',  'Prueba Sistema ANPR', 'Desarrollo / Tesis', 'Prueba', 1)
        `);
        console.log('[DB] Vehículos autorizados de prueba sembrados.');
      }
    } catch (whitelistErr: any) {
      // Ignorar si no existe
    }

    // Limpiar detecciones simuladas ficticias previas
    try {
      await pool.request().query(`
        DELETE FROM DeteccionVehiculo WHERE fuente = 'simulacion' OR imagen_vehiculo_path LIKE '%simulado%';
        DELETE FROM EventosIngreso WHERE imagen_vehiculo_path LIKE '%simulado%';
      `);
      console.log('[DB] Registros de simulación ficticios purgados.');
    } catch (e: any) {
      // Ignorar si no existe
    }
  } catch (error: any) {
    console.error('[DB] Error al sembrar datos de prueba:', error.message);
  }
}

export function getDB(): sql.ConnectionPool {
  if (!pool) {
    throw new Error('[DB] Pool de base de datos no inicializado.');
  }
  return pool;
}
