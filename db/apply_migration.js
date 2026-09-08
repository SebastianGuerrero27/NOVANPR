const sql = require('mssql');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../backend/.env') });

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '14333'),
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true }
};

async function run() {
  try {
    const pool = await sql.connect(config);
    console.log('Conectado a SQL Server.');

    // Ejecutar statements uno por uno
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'estado')
      BEGIN
        ALTER TABLE Camaras ADD estado VARCHAR(20) DEFAULT 'ACTIVA';
      END;
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'ultimo_ping')
      BEGIN
        ALTER TABLE Camaras ADD ultimo_ping DATETIME NULL;
      END;
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'tiempo_respuesta_ms')
      BEGIN
        ALTER TABLE Camaras ADD tiempo_respuesta_ms INT NULL;
      END;
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'mensaje_ping')
      BEGIN
        ALTER TABLE Camaras ADD mensaje_ping VARCHAR(255) NULL;
      END;
    `);

    await pool.request().query(`
      UPDATE Camaras 
      SET estado = CASE WHEN activa = 1 THEN 'ACTIVA' ELSE 'INACTIVA' END 
      WHERE estado IS NULL;
    `);

    const cols = await pool.request().query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Camaras'");
    console.log('Columnas de Camaras en DB:', cols.recordset.map(c => `${c.COLUMN_NAME} (${c.DATA_TYPE})`));
    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error('Error aplicando migración:', err);
    process.exit(1);
  }
}

run();
