const sql = require('mssql');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });

const config = {
  user: process.env.DB_USER || 'sa',
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '14333'),
  database: process.env.DB_NAME || 'ANPR_ECU911',
  options: { encrypt: false, trustServerCertificate: true }
};

async function run() {
  try {
    const pool = await sql.connect(config);
    console.log('Conectado a SQL Server.');

    console.log('Ampliando columnas de placa a VARCHAR(20)...');
    await pool.request().query(`
      ALTER TABLE DeteccionVehiculo ALTER COLUMN placa VARCHAR(20) NULL;
      ALTER TABLE DeteccionVehiculo ALTER COLUMN placa_reconocida VARCHAR(20) NULL;
      ALTER TABLE DeteccionVehiculo ALTER COLUMN placa_validada VARCHAR(20) NULL;
    `);

    const cols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'DeteccionVehiculo' AND COLUMN_NAME IN ('placa', 'placa_reconocida', 'placa_validada', 'tipo_vehiculo', 'estado_procesamiento', 'estado_validacion');
    `);
    console.log('Columnas actualizadas:', cols.recordset);

    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error('Error ampliando columnas:', err);
    process.exit(1);
  }
}

run();
