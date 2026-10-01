import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { crearApp } from './app';
import { connectDB } from './config/db';
import { initSocket } from './services/socket';
import { iniciarSincronizacionMedios } from './services/medios';
import { iniciarMonitorCamaras } from './services/conectividadCamaras';
import { iniciarSincronizacionMotor } from './services/camaraMotor';
import { iniciarWebPush } from './services/webPush';
import { iniciarTareasProgramadas } from './services/tareasProgramadas';

const app = crearApp();
const server = createServer(app);
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // Base de datos (con reintentos) y esquema; luego los canales de tiempo real y las tareas
    const pool = await connectDB();
    await iniciarWebPush(pool);

    initSocket(server);
    iniciarMonitorCamaras();
    iniciarSincronizacionMedios();
    iniciarSincronizacionMotor();
    iniciarTareasProgramadas();

    server.listen(PORT, () => {
      console.log(`===================================================`);
      console.log(`  ECU 911 ANPR Backend iniciado en puerto ${PORT}`);
      console.log(`  Entorno: ${process.env.NODE_ENV || 'development'}`);
      console.log(`===================================================`);
    });
  } catch (error: any) {
    console.error('Error catastrófico al iniciar el backend:', error.message);
    process.exit(1);
  }
}

startServer();
