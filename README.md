# NOVANPR

Proyecto ANPR para ECU 911 Coordinación Zonal 3 (Ambato). Titular: SelfSteer Public Access Network S.A., empresa con fines de lucro de beneficio público.

Reconocimiento automático de placas (ANPR) con aprendizaje profundo para el control de ingreso
vehicular: detección y lectura de placas en tiempo real, permisos de placa con vigencia y horario,
lista de alertas, solicitudes de acceso, centro de alarmas con notificaciones en tiempo real y Web
Push, y evaluación científica del reconocimiento y de las alarmas.

Estado actual (octubre de 2026): el paso se registra en menos de 1 s desde la foto (lo que el
verificador o el análisis del vehículo aporten después llega como reevaluación), solo se registran
lecturas con forma de placa, la interfaz usa los colores institucionales con barra de pestañas tipo
IDE y la placa se muestra siempre con la foto real del recorte. Pruebas: backend 741, motor 189,
frontend 46, todas en verde.

## Componentes

| Carpeta | Servicio | Tecnología |
|---|---|---|
| `frontend/` | Interfaz web por roles | React 18 + TypeScript + Vite, Socket.IO, service worker Web Push; diseño institucional ECU 911 |
| `backend/` | API, política de acceso, centro de notificaciones | Express + TypeScript, Socket.IO (adaptador Redis), web-push, PostgreSQL (`pg`) |
| `services/anpr/` | Motor de reconocimiento | FastAPI + Python: detector YOLO26n afinado (RF-DETR como alternativa), seguimiento con filtro de Kalman, OCR cct-s-v2-global (ONNX), verificador PP-OCRv6 (OpenVINO), atributos del vehículo con CLIP |
| `db/` | Esquema y migraciones | PostgreSQL 17 (`postgresql/esquema.sql`) |
| `mediamtx/` | Video | Relay RTSP → WebRTC (WHEP) |
| `monitoring/` | Observabilidad | Prometheus + Grafana |
| `k8s/` | Despliegue | Kustomize (base + overlays staging/producción); CI/CD con GitHub Actions y GHCR ([docs/CICD.md](docs/CICD.md)) |

## Roles

| Rol | Resumen |
|---|---|
| Guardia | Punto de control: monitoreo, validación de lecturas, registro manual, solicitudes de acceso; recibe cada permiso otorgado con enlace a la lista blanca |
| **Gestor de permisos** | Una sola vista: otorga permisos de placa (categoría, vigencia, franjas horarias) y resuelve solicitudes; sin monitoreo, solo se le notifica la llegada de los vehículos a los que dio permiso |
| Administrador | Todo: usuarios, cámaras, configuración, auditoría, lista de alertas, excepciones, reportes y evaluación |

La API se documenta con **Swagger UI** en `http://localhost:5000/api/docs` (especificación OpenAPI en `/api/docs.json`).

Matriz completa de permisos: [docs/ROLES_Y_PERMISOS.md](docs/ROLES_Y_PERMISOS.md).

## Puesta en marcha

Guía paso a paso para el uso diario, la instalación en otro equipo, los ajustes y los problemas
frecuentes: **[EJECUTAR_SISTEMA.md](EJECUTAR_SISTEMA.md)**. Instalación en el servidor de producción
(imágenes compiladas, `docker-compose.prod.yml`): **[INSTALAR_PRODUCCION.md](INSTALAR_PRODUCCION.md)**.

Requisitos: Docker Desktop y los puertos 3000 (frontend), 5000 (API), 8000 (motor), 8554/8889/8189
(MediaMTX), 5432 (PostgreSQL), 9090/3001 (Prometheus/Grafana) libres.

```bash
cp .env.example .env     # defina DB_PASSWORD, JWT_SECRET, ANPR_SERVICE_TOKEN, GRAFANA_ADMIN_PASSWORD
                         # y CAMARAS_CLAVE_CIFRADO (openssl rand -base64 32)
docker compose up --build
```

- Frontend: <http://localhost:3000> · API: <http://localhost:5000> · Motor: <http://localhost:8000>
- Para la red local se publican el frontend, la API, el motor (solo WebSocket con ticket) y el
  WebRTC de MediaMTX (8889, 8189). PostgreSQL (5432), Redis, Prometheus, Grafana y el RTSP de
  MediaMTX (8554) quedan solo en `127.0.0.1` del equipo anfitrión.
- Cada servicio tiene healthcheck (`docker compose ps` muestra *healthy*): el backend responde
  `/health/ready` cuando PostgreSQL está disponible y el motor arranca después de él.
- **No hay cámaras predefinidas:** se registran en *Operación › Registro de cámaras* (URL RTSP con
  la contraseña cifrada en la base). Solo se aceptan direcciones dentro de
  `CAMARAS_REDES_PERMITIDAS` (por omisión, redes privadas); en producción, defina la VLAN de cámaras.
- **No hay usuarios predefinidos:** al abrir el sistema por primera vez se muestra la configuración
  inicial para crear el primer administrador; luego se crean las demás cuentas en *Usuarios*.
- El esquema PostgreSQL se aplica al arrancar el backend.
- Las notificaciones push del navegador requieren `https` o `http://localhost` (ver
  [docs/NOTIFICACIONES.md](docs/NOTIFICACIONES.md)).

## Pruebas

```bash
cd backend && npm test                     # dominio, orquestación, integración RBAC, esquema, seguridad HTTP
cd frontend && npm test && npm run lint && npm run build   # HUD, formularios, estados; tipos + build
cd services/anpr && pytest                 # motor ANPR (requiere sus dependencias)
bash backend/scripts/camara_hikvision_simulada/e2e.sh     # punta a punta con una Hikvision simulada

# Con el sistema en marcha:
node backend/scripts/aceptacion_e2e.js --api http://localhost:5000 --servicio "$ANPR_SERVICE_TOKEN" --log backend.log
node backend/scripts/benchmark_notificaciones.js --api http://localhost:5000 --servicio "$ANPR_SERVICE_TOKEN" \
     --email <cuenta> --password '…' --muestras 200
```

## Documentación

| Documento | Contenido |
|---|---|
| [docs/ANALISIS_ARQUITECTURA.md](docs/ANALISIS_ARQUITECTURA.md) | Análisis del código, hallazgos, decisiones de diseño, estado del arte y protocolo de evaluación (base del artículo) |
| [docs/ROLES_Y_PERMISOS.md](docs/ROLES_Y_PERMISOS.md) | RBAC, separación de funciones, permisos de placa con horario (TRBAC) |
| [docs/NOTIFICACIONES.md](docs/NOTIFICACIONES.md) | Centro de alarmas: tecnología, arquitectura, ciclo ISA-18.2, API y resultados |
| [docs/SISTEMA_WEB.md](docs/SISTEMA_WEB.md) | Pantallas, tiempo real, video y seguridad |
| [docs/CAMARA_HIKVISION_ANPR.md](docs/CAMARA_HIKVISION_ANPR.md) | Cámaras Hikvision (H.265/H.265+): estado del arte, doble flujo, credenciales cifradas, configuración, validación y lista de producción |
| [docs/METODO_VERIFICACION_LECTURA.md](docs/METODO_VERIFICACION_LECTURA.md) | Validez de la lectura y regla de autorización |
| [docs/EXPERIMENTO_MODELOS.md](docs/EXPERIMENTO_MODELOS.md) | Experimento de detectores y OCR, estadística |
| [docs/BASE_DE_DATOS.md](docs/BASE_DE_DATOS.md) | Esquema PostgreSQL y reglas de negocio |
| [docs/AUDITORIA_MOTOR_ANPR.md](docs/AUDITORIA_MOTOR_ANPR.md) | Flujo real del motor, deduplicación, OCR, registro en menos de 1 s, latencias medidas y riesgos |
| [docs/PROTOCOLO_EVALUACION_SECUENCIAS.md](docs/PROTOCOLO_EVALUACION_SECUENCIAS.md) | Protocolo para evaluar el motor con video real etiquetado |
| [docs/ARQUITECTURA_LIMPIA.md](docs/ARQUITECTURA_LIMPIA.md) | Capas y regla de dependencias de backend, frontend y motor |
| [docs/CUMPLIMIENTO_NORMAS.md](docs/CUMPLIMIENTO_NORMAS.md) | Trazabilidad con ISO/IEC 25010, 12207, 29119, OWASP ASVS, ISO/IEC 27001 y LOPDP |
| [ESTADO_DEL_SISTEMA.md](ESTADO_DEL_SISTEMA.md), [walkthrough_dos_fases.md](walkthrough_dos_fases.md) | Arquitectura vigente y recorrido de un paso vehicular de la cámara al registro |
| [MARCO_TEORICO_TESIS.md](MARCO_TEORICO_TESIS.md), [CADENAS_BUSQUEDA_LITERATURA.md](CADENAS_BUSQUEDA_LITERATURA.md) | Marco teórico de la tesis (categorías de las variables) y búsqueda bibliográfica |
| [docs/MONITORING.md](docs/MONITORING.md), [docs/CICD.md](docs/CICD.md) | Operación |
