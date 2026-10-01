# Sistema ANPR · ECU 911 Coordinación Zonal 3 (Ambato)

Reconocimiento automático de placas (ANPR) con aprendizaje profundo para el control de ingreso
vehicular: detección y lectura de placas en tiempo real, permisos de placa con vigencia y horario,
lista de alertas, solicitudes de acceso, centro de alarmas con notificaciones en tiempo real y Web
Push, y evaluación científica del reconocimiento y de las alarmas.

## Componentes

| Carpeta | Servicio | Tecnología |
|---|---|---|
| `frontend/` | Interfaz web por roles | React 18 + TypeScript + Vite, Socket.IO, service worker Web Push |
| `backend/` | API, política de acceso, centro de notificaciones | Express + TypeScript, Socket.IO (adaptador Redis), web-push, SQL Server |
| `services/anpr/` | Motor de reconocimiento | FastAPI + Python: YOLO26n / RF-DETR, OCR cct-s-v2, verificador PP-OCRv6 (OpenVINO) |
| `db/` | Esquema y migraciones | SQL Server 2022 (`init.sql` + `migration_*.sql`, registradas en `SchemaMigraciones`) |
| `mediamtx/` | Video | Relay RTSP → WebRTC (WHEP) |
| `monitoring/` | Observabilidad | Prometheus + Grafana |

## Roles

| Rol | Resumen |
|---|---|
| Operador | Garita: monitoreo, validación de lecturas, registro manual, solicitudes de acceso, aviso con protocolo |
| **Gestor de accesos** | Permisos de placa (categoría, vigencia, franjas horarias), resolución de solicitudes, excepciones; alertas de accesos denegados |
| Supervisor | Listas de control, reportes, evaluación, alarmas escaladas |
| Administrador | Todo, más usuarios, cámaras, configuración y auditoría |

Matriz completa de permisos: [docs/ROLES_Y_PERMISOS.md](docs/ROLES_Y_PERMISOS.md).

## Puesta en marcha

Requisitos: Docker Desktop y los puertos 3000 (frontend), 5000 (API), 8000 (motor), 8554/8889/8189
(MediaMTX), 14333 (SQL Server), 9090/3001 (Prometheus/Grafana) libres.

```bash
cp .env.example .env     # defina MSSQL_SA_PASSWORD, JWT_SECRET, ANPR_SERVICE_TOKEN, GRAFANA_ADMIN_PASSWORD
docker compose up --build
```

- Frontend: <http://localhost:3000> · API: <http://localhost:5000> · Motor: <http://localhost:8000>
- **No hay usuarios predefinidos:** al abrir el sistema por primera vez se muestra la configuración
  inicial para crear el primer administrador; luego se crean las demás cuentas en *Usuarios*.
- El esquema y las migraciones se aplican solos al arrancar el backend.
- Las notificaciones push del navegador requieren `https` o `http://localhost` (ver
  [docs/NOTIFICACIONES.md](docs/NOTIFICACIONES.md)).

## Pruebas

```bash
cd backend && npm test                     # 191 pruebas: dominio, orquestación, integración RBAC, esquema
cd frontend && npm run build               # verificación de tipos + build
cd services/anpr && pytest                 # motor ANPR (requiere sus dependencias)

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
| [docs/METODO_VERIFICACION_LECTURA.md](docs/METODO_VERIFICACION_LECTURA.md) | Validez de la lectura y regla de autorización |
| [docs/EXPERIMENTO_MODELOS.md](docs/EXPERIMENTO_MODELOS.md) | Experimento de detectores y OCR, estadística |
| [docs/BASE_DE_DATOS.md](docs/BASE_DE_DATOS.md) | Esquema v5 y reglas de negocio |
| [docs/MONITORING.md](docs/MONITORING.md), [docs/CICD.md](docs/CICD.md), [docs/REDIS_CACHE.md](docs/REDIS_CACHE.md) | Operación |
