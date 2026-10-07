import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { crearApp } from './app';
import { connectDB } from './infraestructura/db';
import { initSocket } from './infraestructura/servicios/socket';
import { iniciarSincronizacionMedios } from './infraestructura/servicios/medios';
import { iniciarMonitorCamaras } from './infraestructura/servicios/conectividadCamaras';
import { iniciarSincronizacionMotor } from './infraestructura/servicios/camaraMotor';
import { iniciarWebPush } from './infraestructura/servicios/webPush';
import { iniciarTareasProgramadas } from './infraestructura/servicios/tareasProgramadas';

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
