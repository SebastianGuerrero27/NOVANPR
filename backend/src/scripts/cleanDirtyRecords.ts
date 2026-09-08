import { connectDB, getDB } from '../config/db';

async function main() {
  await connectDB();
  const db = getDB();
  const res = await db.request().query(`
    DELETE FROM DeteccionVehiculo 
    WHERE placa = 'NO_LEGIBLE' 
       OR placa = 'PROCESANDO...' 
       OR placa = 'PROCESANDO' 
       OR LEN(REPLACE(ISNULL(placa, ''), '-', '')) < 5;
       
    DELETE FROM EventosIngreso
    WHERE placa = 'NO_LEGIBLE' 
       OR placa = 'PROCESANDO...' 
       OR placa = 'PROCESANDO' 
       OR LEN(REPLACE(ISNULL(placa, ''), '-', '')) < 5;
  `);
  console.log('SQL Server: Registros no legibles y datos sucios purgados exitosamente.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error al purgar registros:', err);
  process.exit(1);
});
