# Sistema ANPR para el ECU 911 - Coordinación Zonal 3 (Ambato)

Este repositorio contiene la solución completa de Reconocimiento Automático de Placas Vehiculares (ANPR) basada en Deep Learning para reemplazar el control de acceso vehicular manual.

## Requisitos Previos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado y en ejecución en su sistema operativo.
- Puertos `3000` (Frontend), `5000` (Backend), `8000` (ANPR), `8554` (MediaMTX RTSP), `8888` (MediaMTX HLS) y `1433` (SQL Server) disponibles.

---

## Estructura del Monorepositorio

- **`frontend/`**: Cliente web React 18 + TS + Vite.
- **`backend/`**: Servidor de API Express + TS con soporte Socket.io y conexión a SQL Server.
- **`services/anpr/`**: Microservicio Python + FastAPI que ejecuta inferencias de YOLOv8 y OCR de caracteres.
- **`mediamtx/`**: Servidor relay de video para flujos HLS y RTSP.
- **`db/`**: Archivos de esquema de base de datos (`init.sql`).
- **`docker-compose.yml`**: Configuración de orquestación de contenedores.

---

## Cómo Ejecutar el Proyecto

1. Clone o descargue este repositorio.
2. Abra una terminal en la carpeta raíz del proyecto y ejecute:
   ```bash
   docker compose up --build
   ```
3. Docker descargará las imágenes correspondientes, creará la base de datos SQL Server, inicializará las tablas automáticamente y sembrará los datos iniciales de prueba.
4. El microservicio ANPR de Python inicializará el detector YOLOv8 y EasyOCR.

### Enlaces de Acceso Local
- **Frontend**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:5000](http://localhost:5000)
- **FastAPI ANPR Service**: [http://localhost:8000](http://localhost:8000)
- **Panel MediaMTX (HLS/WebRTC)**: [http://localhost:8888](http://localhost:8888)

---

## Credenciales de Acceso por Defecto
El sistema cuenta con usuarios semilla creados automáticamente al primer arranque:

| Rol | Usuario | Contraseña |
| :--- | :--- | :--- |
| **Administrador** | `admin` | `PasswordAdmin123!` |
| **Operador** | `operator` | `PasswordOperator123!` |

---

## Modo de Simulación de Tránsito (Prueba Inmediata)

Para que el proyecto sea **100% testable de inmediato**, el microservicio ANPR cuenta con una validación de conexión inteligente:
- Si la cámara física Hikvision en la IP `10.126.9.104` no está conectada o no es accesible desde su red local, el servicio ANPR detectará el fallo tras 3 intentos.
- Se activará automáticamente el **Modo Simulación de Tránsito**, el cual simulará el ingreso de un vehículo cada **30 segundos** enviando fotos de prueba y placas aleatorias.
- Algunas placas coincidirán con la **Lista Negra** activa (`PBA-1234` y `TBG-987`), lo cual activará las notificaciones rojas flotantes en tiempo real y la alarma audible en la pantalla de monitoreo.

---

## Ejecución de Pruebas Unitarias

### Backend (Node.js/Jest)
Para ejecutar las pruebas del backend en su máquina local:
```bash
cd backend
npm install
npm test
```

### ANPR Service (Python/Pytest)
Para ejecutar las pruebas de validación de placas del microservicio:
```bash
cd services/anpr
pip install -r requirements.txt
pytest
```
