# Cumplimiento de normas y buenas prácticas de ingeniería de software

Matriz de trazabilidad entre las normas de referencia y la evidencia verificable en el repositorio.
Sirve para la sección de metodología y validación de la tesis y para el artículo científico. Cada
fila indica **dónde** está la evidencia; lo que aún no se cumple se declara en la sección final.

> Ninguna norma garantiza por sí sola la aceptación de un artículo: los revisores evalúan la
> contribución, la validez experimental y la reproducibilidad. Esta matriz cubre la parte de
> ingeniería; la validez del experimento de reconocimiento depende del conjunto de datos (ver
> [Limitaciones](#limitaciones-declaradas)).

## 1. Calidad del producto — ISO/IEC 25010:2023

| Característica | Evidencia |
|---|---|
| Adecuación funcional | Requisitos por rol en [ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md); CRUD de cada entidad documentado en Swagger (`/api/docs`) y verificado por `backend/src/tests/interfaz/openapi.test.ts` |
| Eficiencia de desempeño | Latencias del detector y del OCR medidas en [EXPERIMENTO_MODELOS.md](EXPERIMENTO_MODELOS.md) y `services/anpr/models/MODEL_CARD.md`; métricas Prometheus (`/metrics`) y tableros Grafana ([MONITORING.md](MONITORING.md)) |
| Compatibilidad | API REST con contrato OpenAPI 3.0.3; despliegue en contenedores (Docker Compose y Kubernetes) |
| Capacidad de interacción (usabilidad) | Validación en el formulario antes de enviar, mensajes de error junto al campo con `aria-describedby`, menú por rol, vista única para el gestor de permisos |
| Fiabilidad | Notificaciones guardadas antes de emitirse (entrega "al menos una vez"), escalamiento de alarmas, reintentos de conexión a la base, migraciones idempotentes con suma SHA-256 |
| Seguridad | Ver secciones 4 y 5 (OWASP ASVS, ISO/IEC 27001) |
| Mantenibilidad | Arquitectura limpia ([ARQUITECTURA_LIMPIA.md](ARQUITECTURA_LIMPIA.md)) con la regla de dependencias verificada por `backend/src/tests/arquitectura.test.ts`; casos de uso probados con dobles de prueba; validación centralizada en `dominio/validacion.ts`; código sin uso eliminado |
| Flexibilidad (portabilidad) | Configuración por variables de entorno; modelos intercambiables (`PLATE_MODEL_PATH`, `PLATE_DETECTOR_ARCH`); manifiestos Kustomize por entorno |

## 2. Ciclo de vida — ISO/IEC/IEEE 12207:2017

| Proceso | Evidencia |
|---|---|
| Gestión de la configuración | Git con ramas y pull requests; migraciones de base versionadas (`db/migration_v*.sql`, tabla `SchemaMigraciones`) |
| Integración y verificación | CI en GitHub Actions (`.github/workflows/ci.yml`): pruebas del backend, del servicio ANPR y del frontend, build de imágenes y análisis Trivy |
| Transición y operación | CD a Kubernetes (`cd.yml`, `deploy-k8s.yml`, [CICD.md](CICD.md)); monitoreo y alertas |
| Gestión de la calidad | Esta matriz; fichas de modelo; revisión de código en pull requests |

## 3. Pruebas — ISO/IEC/IEEE 29119

| Nivel | Evidencia |
|---|---|
| Unitarias (dominio) | `backend/src/tests/dominio/` — reglas de acceso, horarios, RBAC, validación de placas y campos, períodos, cámaras |
| Unitarias (casos de uso) | `backend/src/tests/aplicacion/` — con dobles de prueba, sin base de datos |
| Integración (API) | `backend/src/tests/integration/api.test.ts` — matriz rol × endpoint (autorización RBAC) |
| Contrato | `backend/src/tests/interfaz/openapi.test.ts` — toda ruta montada está documentada y viceversa |
| Arquitectura | Pruebas de aptitud: `backend/src/tests/arquitectura.test.ts`, `frontend/scripts/verificar-arquitectura.mjs` (en `npm run build`) y `services/anpr/tests/test_arquitectura.py` — ninguna capa interna depende de una externa |
| Adaptadores | `backend/src/tests/infraestructura/` — repositorios SQL, migraciones, notificaciones, métricas |
| Aceptación extremo a extremo | `backend/scripts/aceptacion_e2e.js` — flujo completo con la API real |
| Servicio ANPR | `services/anpr/tests/` (pytest) |
| Resultado (2026-10-05) | Backend: 38 suites, 646 pruebas en verde; servicio ANPR: 101 pruebas en verde (incluidas 22 de contrato del motor y del servidor); compilación TypeScript sin errores en backend y frontend; pruebas de aptitud de la arquitectura en verde en los tres componentes |
| Evaluación del reconocimiento | `services/anpr/scripts/evaluate_detectors.py`, `benchmark_ocr.py`, `estadistica.py` (IC 95 %, McNemar, bootstrap) |

## 4. Seguridad de aplicaciones — OWASP ASVS 4.0.3 (nivel 2)

| Capítulo | Control | Evidencia |
|---|---|---|
| V1 Arquitectura | Capas con dependencias hacia adentro; controles de acceso en un único punto | `ARQUITECTURA_LIMPIA.md`; `interfaz/http/middlewares/auth.ts` (`requierePermiso`) |
| V2 Autenticación | Política de contraseñas, bloqueo por intentos, respuesta y tiempo iguales ante un correo inexistente, tokens de un solo uso (solo se guarda su hash) | `dominio/usuarios.ts`, `aplicacion/auth.ts`, `infraestructura/servicios/seguridad.ts` |
| V3 Sesiones | JWT con expiración; el rol se relee de la base en cada solicitud; cierre de sockets al cambiar rol, bloquear o dar de baja | `infraestructura/sesiones.ts`, `interfaz/http/middlewares/auth.ts` |
| V4 Control de acceso | RBAC (NIST/ANSI INCITS 359-2004) por permisos; separación de funciones en solicitudes; matriz probada | `dominio/permisos.ts`, `tests/integration/api.test.ts` |
| V5 Validación | Lista de permitidos en todo dato de entrada (placa, nombres, enteros, fechas, correo, host) y en los filtros de consulta; arreglos y objetos rechazados; consultas parametrizadas; texto sin `<` `>` | `dominio/validacion.ts` (backend) y `lib/validacion.ts` (frontend) |
| V7 Errores y registros | Errores 500 sin detalles internos; auditoría de solo inserción con usuario, IP y fecha | `interfaz/http/respuesta.ts`; `infraestructura/adaptadores.ts` |
| V8 Protección de datos | Evidencia fotográfica solo con enlace firmado y con vencimiento; la contraseña RTSP de las cámaras nunca sale de la API ni de los registros | `infraestructura/servicios/media.ts`, `dominio/camaras.ts` |
| V11 Lógica de negocio | Operaciones atómicas en el repositorio; control de concurrencia optimista en la aprobación de solicitudes (no se aprueba lo que cambió mientras se revisaba); cupo por hora en la consulta de propietarios | `aplicacion/solicitudesAcceso.ts`, `aplicacion/propietario.ts` |
| V12 Archivos | Nombres de archivo validados contra recorrido de rutas | `app.ts` (`/media/:archivo`) |
| V14 Configuración | Secretos solo por variables de entorno; Swagger desactivado en producción salvo `SWAGGER_HABILITADO=true`; análisis de dependencias (`npm audit`, Trivy) | `app.ts`, `ci.yml` |

## 5. Seguridad de la información — ISO/IEC 27001:2022 (Anexo A)

| Control | Evidencia |
|---|---|
| A.5.15 Control de acceso / A.8.2 Derechos privilegiados | RBAC con tres roles (Administrador, Guardia, Gestor de permisos) y mínimo privilegio |
| A.5.3 Segregación de funciones | Quien solicita un acceso no puede aprobarlo |
| A.8.15 Registro de eventos | Auditoría inmutable (sin edición ni borrado), consulta con filtros, exportación CSV y retención por archivo auditada |
| A.8.16 Monitoreo | Prometheus, Grafana, alarmas escaladas |
| A.8.28 Codificación segura | Validación centralizada, consultas parametrizadas, neutralización de inyección de fórmulas en CSV |
| A.8.32 Gestión de cambios | Pull requests, CI, migraciones versionadas |

## 6. Protección de datos personales — LOPDP (Ecuador, 2021)

| Principio | Evidencia |
|---|---|
| Minimización | Solo se guardan placa, imagen del paso y datos del titular del permiso necesarios para el control de acceso |
| Seguridad y confidencialidad | Acceso por rol, enlaces firmados a la evidencia, auditoría de consultas al propietario |
| Conservación limitada | Retención configurable de la auditoría; eliminación de detecciones con motivo auditado |

## 7. Reproducibilidad científica del componente de aprendizaje automático

| Práctica | Evidencia |
|---|---|
| Model Cards (Mitchell et al., 2019) | `services/anpr/models/MODEL_CARD.md`: datos, entrenamiento, métricas, SHA-256 y limitaciones |
| Protocolo experimental y estadística | [EXPERIMENTO_MODELOS.md](EXPERIMENTO_MODELOS.md); IC 95 %, prueba de McNemar, bootstrap |
| Semillas y determinismo | Entrenamientos con semilla fija y modo determinista (ficha del modelo) |
| Artefactos | Pesos versionados con su suma SHA-256; scripts de preparación, entrenamiento y evaluación en `services/anpr/scripts/` |

## Limitaciones declaradas

1. **Conjunto de datos ecuatoriano insuficiente.** El conjunto propio tiene 101 fotos de interiores con
   2 placas reales; el detector en producción se entrenó con Open Images V7 (sin placas
   ecuatorianas). Antes de publicar resultados de reconocimiento hace falta un conjunto de al menos
   300–500 imágenes de 100 o más vehículos distintos, capturadas con la cámara real, con partición por
   vehículo y día (ver `MODEL_CARD.md`).
2. **Dependencias con vulnerabilidades conocidas en herramientas de desarrollo** (`jest` 29,
   `ts-node-dev`) y moderadas en `mssql` 10: su corrección exige actualizaciones mayores.
