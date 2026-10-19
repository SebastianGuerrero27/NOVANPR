# Cómo ejecutar el sistema ANPR

Guía para levantar, usar, detener y diagnosticar el sistema en un equipo con Windows y Docker
Desktop. Todos los comandos se ejecutan desde la carpeta raíz del proyecto
(`C:\Users\ASUS\Desktop\TITULACION\ANPR`), en PowerShell o en Git Bash.

## 1. Requisitos

- **Docker Desktop** (con WSL 2) instalado.
- **Memoria:** 16 GB de RAM recomendados. Los contenedores tienen topes que suman unos 12 GB; el
  motor usa hasta 6 GB y PostgreSQL hasta 1 GB.
- **Disco:** unos 15 GB libres para las imágenes (el motor ocupa ~9 GB) y la caché de modelos.
- **Puertos libres:** 3000 (web), 5000 (API), 8000 (motor), 8889 y 8189 (video WebRTC), y en el
  propio equipo 5432 (PostgreSQL), 6379 (Redis), 8554 (RTSP), 9090 (Prometheus) y 3001 (Grafana).

## 2. Uso diario (el sistema ya está instalado)

1. **Abra Docker Desktop** y espere a que indique que el motor de Docker está en marcha.
   Los contenedores tienen `restart: always`: al iniciar Docker Desktop **el sistema arranca solo**.
2. Si no arrancara, levántelo a mano:

   ```bash
   docker compose up -d
   ```

3. Compruebe que todo esté sano (puede tardar 1–3 minutos; el motor carga sus modelos):

   ```bash
   docker compose ps
   ```

   Los servicios deben decir `healthy` (MediaMTX no tiene healthcheck y solo dice `Up`).
4. Abra el sistema en el navegador: **<http://localhost:3000>** e ingrese con su cuenta.

> La primera vez después de reiniciar el equipo, el primer análisis pesado puede tardar bastante
> más (carga en frío de los modelos). Desde la segunda vez, los tiempos son los normales.

## 3. Direcciones

| Servicio | Dirección | Notas |
|---|---|---|
| Sistema web | <http://localhost:3000> | También desde la red local: `http://<IP-del-equipo>:3000` |
| API (Swagger) | <http://localhost:5000/api/docs> | Estado: <http://localhost:5000/health/ready> |
| Motor ANPR | <http://localhost:8000/status> | Estado del motor, latencias y etapas |
| Grafana | <http://127.0.0.1:3001> | Usuario `admin`, contraseña `GRAFANA_ADMIN_PASSWORD` del `.env` |
| Prometheus | <http://127.0.0.1:9090> | Métricas del motor y de la API |
| PostgreSQL | `127.0.0.1:5433` (host) / `db:5432` (Docker) | Base `ANPR_ECU911`, usuario `DB_USER`, contraseña `DB_PASSWORD` del `.env` |

## 4. Poner a funcionar el reconocimiento

1. **Primer ingreso:** si la base no tiene usuarios, el sistema abre la *configuración inicial*
   para crear el primer administrador. Las demás cuentas se crean en **Usuarios**.
2. **Registrar la cámara:** en **Operación › Registro de cámaras › Registrar cámara**, con la URL
   RTSP del flujo principal (y, si existe, el secundario para la vista en vivo). La contraseña se
   guarda cifrada. Solo se aceptan direcciones dentro de `CAMARAS_REDES_PERMITIDAS` (redes privadas
   por omisión).
3. **Comprobar el enlace:** botones **Ping** (red y RTSP) y **Play** (video real).
4. **Zonas:** botón **Zonas** para dibujar el área donde se buscan placas y excluir árboles,
   banderas o reflejos que generan movimiento falso.
5. **Asignar la cámara al motor:** en **Monitoreo**, selector *Cámara que procesa el motor ANPR*.
   Desde ese momento se ven el video, los recuadros de las placas y los pasos en **Detecciones**.

La cámara debe ser alcanzable desde este equipo: si figura **SIN_CONEXION**, revise la red o VLAN
de cámaras y vuelva a probar con **Ping**. El motor se reconecta solo cuando vuelve la señal.

### Prueba sin cámara real

Para verificar el sistema de punta a punta sin la cámara de la garita (en Git Bash):

```bash
bash backend/scripts/camara_hikvision_simulada/e2e.sh
```

Levanta una cámara Hikvision **simulada**, la registra, mide el análisis y un corte de red, y al
final **borra la cámara y las detecciones de la prueba** (solo las suyas) y devuelve el motor a su
cámara anterior. El resultado queda en
`backend/scripts/camara_hikvision_simulada/.trabajo/resultado_e2e.txt`. No sirve como demostración
de reconocimiento real: la escena es sintética.

## 5. Detener el sistema

```bash
docker compose stop      # detiene los contenedores y conserva todos los datos
```

- `docker compose down` también conserva los datos (borra solo los contenedores).
- **Nunca use `docker compose down -v`** salvo que quiera borrar la base de datos, Redis, Grafana y
  la caché de modelos: `-v` elimina los volúmenes.
- Cerrar Docker Desktop detiene todo; al abrirlo de nuevo el sistema vuelve a arrancar.

## 6. Instalación en un equipo nuevo

1. Copie el proyecto y cree el archivo de secretos a partir del ejemplo:

   ```bash
   cp .env.example .env
   ```

2. Complete en `.env` al menos: `DB_PASSWORD`, `JWT_SECRET`, `ANPR_SERVICE_TOKEN`,
   `GRAFANA_ADMIN_PASSWORD` y `CAMARAS_CLAVE_CIFRADO`. Valores aleatorios seguros:

   ```bash
   openssl rand -base64 32     # para JWT_SECRET, ANPR_SERVICE_TOKEN y CAMARAS_CLAVE_CIFRADO
   ```

   Use una contraseña fuerte para PostgreSQL.
3. Construya y levante todo (la primera vez descarga imágenes y modelos; puede tardar bastante):

   ```bash
   docker compose up -d --build
   ```

4. El esquema PostgreSQL se aplica solo al arrancar la API.

> **Importante:** el `.env` de este equipo ya existe. No lo regenere ni cambie
> `CAMARAS_CLAVE_CIFRADO`: las contraseñas de las cámaras guardadas quedarían ilegibles (para
> rotarla, siga `docs/CAMARA_HIKVISION_ANPR.md` §3.3). El `.env` nunca se sube a git.

## 7. Ajustes del motor

Se definen en `services/anpr/.env` (o en `environment:` del servicio `anpr` en
`docker-compose.yml`) y se aplican con `docker compose restart anpr`:

| Variable | Por omisión | Efecto |
|---|---|---|
| `REGISTRO_MAX_MS` | 1000 | Tiempo máximo desde la foto hasta el registro del paso; lo que llega después se reevalúa. `0` = esperar a todas las etapas |
| `OCR_VERIFIER_MAX_MS` | 2000 | Presupuesto del segundo OCR (PP-OCRv6) |
| `PLATE_CONFIDENCE_THRESHOLD` | 0.22 | Umbral del detector de placas (elegido con evidencia; no cambiar sin medir) |
| `ROI_CROP_INFERENCE` | true | Inferencia sobre el recorte del área de detección |
| `TORCH_THREADS` · `OCR_THREADS` · `OCR_VERIFIER_THREADS` | 4 · 2 · 4 | Hilos de cada modelo en CPU |

## 8. Después de modificar el código

| Parte | Qué hacer |
|---|---|
| Backend (`backend/`) y frontend (`frontend/`) | Nada: se recargan solos al guardar |
| Motor (`services/anpr/`) | `docker compose restart anpr` (en Windows la recarga automática no detecta los cambios) |
| Dependencias (`package.json`, `requirements.txt`) o `Dockerfile` | `docker compose up -d --build <servicio>` |
| Base de datos (`db/migration_*.sql` nueva) | Se aplica sola al reiniciar la API: `docker compose restart backend` |

Pruebas automáticas: ver la sección *Pruebas* del [README](README.md).

## 9. Registros y diagnóstico

```bash
docker compose logs -f anpr        # motor: lecturas, validez, registro, latencias
docker compose logs -f backend     # API: decisiones de acceso, errores
docker compose logs --since 10m    # todo lo de los últimos 10 minutos
```

| Síntoma | Causa y solución |
|---|---|
| `error during connect … dockerDesktopLinuxEngine` | Docker Desktop no está abierto: ábralo y espere a que arranque |
| `port is already allocated` | Otro programa usa el puerto: `netstat -ano \| findstr :3000` para ver cuál y cerrarlo |
| El motor sigue en `starting` o `unhealthy` | Está cargando modelos (hasta 3 min). Si no mejora: `docker compose logs anpr` y `docker compose restart anpr` |
| La web abre pero no hay video | La cámara no está asignada al motor o no es alcanzable: revise **Ping** y el selector de **Monitoreo** |
| La cámara no se deja registrar | Su IP está fuera de `CAMARAS_REDES_PERMITIDAS` en `.env` |
| No se puede iniciar sesión tras varios intentos fallidos | Límite de intentos por seguridad: espere unos minutos |
| Comandos `docker exec … /tmp/…` fallan en Git Bash | Git Bash convierte las rutas: anteponga `MSYS_NO_PATHCONV=1` o use PowerShell |
