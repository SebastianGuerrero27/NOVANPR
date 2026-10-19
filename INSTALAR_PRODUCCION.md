# Instalación en producción · Sistema ANPR ECU 911 Coordinación Zonal 3

Guía para instalar el sistema en el servidor de la institución con Docker Compose
(`docker-compose.prod.yml`). Para desarrollo y pruebas en el portátil se usa
[EJECUTAR_SISTEMA.md](EJECUTAR_SISTEMA.md); para Kubernetes, [docs/CICD.md](docs/CICD.md).

## 1. Requisitos del servidor

| Recurso | Mínimo | Recomendado | Motivo |
|---|---|---|---|
| Sistema operativo | Linux de 64 bits con Docker Engine y Compose v2 (Ubuntu Server 22.04/24.04) o Windows con Docker Desktop | Ubuntu Server | Todos los servicios corren en contenedores |
| CPU | 4 núcleos x86-64 con AVX2 | 8 núcleos o más | La detección y el OCR corren en CPU |
| Memoria | 8 GB | 16 GB | PostgreSQL limitado a 768 MiB; el motor ANPR es el principal consumidor |
| Disco | 30 GB libres | 100 GB | Imágenes (~10 GB), base de datos y evidencia fotográfica |
| Red | Acceso a la VLAN de cámaras y a la LAN del personal | IP fija | El navegador del personal abre el sistema por la IP del servidor |
| Internet | Solo en la instalación y en las actualizaciones | — | Descargar imágenes base, dependencias y los pesos de OCR/CLIP del primer arranque |

## 2. Contenido del paquete

```text
NOVANPR/
├── docker-compose.prod.yml      # Producción: imágenes compiladas, sin código montado
├── docker-compose.yml           # Desarrollo (no usar en el servidor)
├── .env.example                 # Plantilla de configuración y secretos
├── INSTALAR_PRODUCCION.md       # Esta guía
├── backend/  frontend/  services/anpr/  db/  mediamtx/  monitoring/  k8s/
└── docs/                        # Documentación técnica
```

Incluye los pesos del detector de placas (`services/anpr/models/license_plate_detector.pt`) y del
detector de vehículos (`services/anpr/yolo26n.pt`). **No incluye** archivos `.env`, contraseñas,
datos de la base ni fotografías de evidencia.

## 3. Instalación

### 3.1 Descomprimir y configurar

```bash
# Linux: copiar NOVANPR.rar al servidor y descomprimir (unrar x NOVANPR.rar)
cd NOVANPR
cp .env.example .env
nano .env
```

Complete en `.env` **los secretos** (genere cada uno; no reutilice los de desarrollo):

| Variable | Cómo generarla |
|---|---|
| `DB_PASSWORD` | Contraseña fuerte para PostgreSQL (12+ caracteres) |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `CAMARAS_CLAVE_CIFRADO` | `openssl rand -base64 32` (obligatoria en producción; guárdela: sin ella hay que reescribir las contraseñas de las cámaras) |
| `ANPR_SERVICE_TOKEN` | `openssl rand -base64 32` |
| `GRAFANA_ADMIN_PASSWORD` | Contraseña fuerte |

Y **la red** (reemplace `192.168.1.50` por la IP del servidor en la LAN):

```dotenv
FRONTEND_URL=http://192.168.1.50:3000
WEBRTC_HOSTS=127.0.0.1,192.168.1.50
WEBRTC_PUBLIC_URL=http://192.168.1.50:8889
ANPR_PUBLIC_URL=http://192.168.1.50:8000
# Solo la VLAN de las cámaras (protección contra SSRF), p. ej.:
CAMARAS_REDES_PERMITIDAS=10.20.30.0/24
```

Opcionales: correo SMTP (`SMTP_*`) para recuperar contraseñas y avisos, y `PUERTO_WEB` si el
puerto 3000 está ocupado.

```bash
chmod 600 .env    # solo el administrador puede leerlo
```

### 3.2 Compilar y arrancar

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

La primera vez compila las imágenes (10–30 min según la conexión) y el motor descarga los pesos de
OCR, del verificador y de CLIP (puede tardar unos minutos más en quedar *healthy*). Compruebe:

```bash
docker compose -f docker-compose.prod.yml ps
```

Todos los servicios deben estar `running`; db, redis, backend y anpr además `healthy`.

### 3.3 Abrir los puertos del firewall

| Puerto | Protocolo | Uso |
|---|---|---|
| 3000 | TCP | Interfaz web y API (nginx) |
| 8000 | TCP | Cajas de detección sobre el video (WebSocket con ticket) |
| 8889 | TCP | Video en vivo WebRTC (señalización) |
| 8189 | UDP y TCP | Video en vivo WebRTC (medios) |

PostgreSQL (5432), la API directa (5000), RTSP (8554), Prometheus (9090) y Grafana (3001) quedan
solo en `127.0.0.1` del servidor y no deben abrirse.

### 3.4 Primer uso

1. Abra `http://<IP del servidor>:3000`: aparece la **configuración inicial** para crear el primer
   administrador (solo funciona mientras no exista ninguno).
2. En **Registro de cámaras**, registre la cámara de la garita con su URL RTSP (la contraseña se
   guarda cifrada). Pruebe con **Ping** y **Play**.
3. En **Zonas**, dibuje el área de detección sobre el carril y las zonas de exclusión.
4. Cree las cuentas del personal en **Usuarios** (Guardia, Gestor de permisos).
5. Antes de activar la autorización automática, valide en sitio con video real según
   [docs/PROTOCOLO_EVALUACION_SECUENCIAS.md](docs/PROTOCOLO_EVALUACION_SECUENCIAS.md) y ajuste la
   cámara ([docs/CAMARA_HIKVISION_ANPR.md](docs/CAMARA_HIKVISION_ANPR.md)).

## 4. Operación

```bash
# Estado y registros
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend anpr

# Detener y volver a arrancar (los datos se conservan en los volúmenes)
docker compose -f docker-compose.prod.yml stop
docker compose -f docker-compose.prod.yml start
```

**Nunca** use `docker compose down -v` ni borre los volúmenes `anpr-produccion_db_data` y
`anpr-produccion_anpr_media`: contienen la base de datos y la evidencia fotográfica.

### 4.1 Respaldos

```bash
# Base de datos PostgreSQL (dump portable)
mkdir -p ./respaldos
docker compose -f docker-compose.prod.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ./respaldos/ANPR_ECU911_$(date +%F).dump

# Evidencia fotográfica
docker run --rm -v anpr-produccion_anpr_media:/media -v "$PWD/respaldos":/respaldo alpine \
  tar czf /respaldo/media_$(date +%F).tar.gz -C /media .
```

Copie los respaldos fuera del servidor según la política de retención de la institución.

### 4.2 Actualizar a una versión nueva

1. Respalde (4.1).
2. Reemplace los archivos del sistema por los del paquete nuevo **conservando `.env`**.
3. `docker compose -f docker-compose.prod.yml up -d --build`. El esquema PostgreSQL se aplica al
   arrancar el backend.

## 5. Seguridad

- `.env` contiene todos los secretos: no lo envíe por correo ni lo guarde en el repositorio.
- Las notificaciones push del navegador exigen HTTPS: para usarlas desde otros equipos, publique el
  puerto web detrás de un proxy con certificado (y mantenga `TRUST_PROXY` con el número de saltos).
- Las cámaras solo se aceptan dentro de `CAMARAS_REDES_PERMITIDAS`.
- No hay usuarios, cámaras ni datos de prueba predefinidos.

## 6. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `Defina … en .env` al arrancar | Falta un secreto | Complete la variable en `.env` |
| backend no queda *healthy* | PostgreSQL aún inicia o la contraseña no coincide | `docker compose -f docker-compose.prod.yml logs db backend`; revise `DB_PASSWORD` |
| La página carga pero no inicia sesión | `FRONTEND_URL` no coincide con la dirección usada | Ponga en `FRONTEND_URL` la URL exacta con la que se abre el sistema |
| Video en negro desde otros equipos | Falta la IP del servidor en `WEBRTC_HOSTS` o el puerto 8189 está bloqueado | Revise `.env` y el firewall |
| Sin cajas de detección sobre el video | `ANPR_PUBLIC_URL` apunta a `localhost` o el puerto 8000 está cerrado | Use la IP del servidor y abra el puerto |
| anpr reinicia en el primer arranque | Descargando pesos sin Internet | Dé salida a Internet en la instalación |
