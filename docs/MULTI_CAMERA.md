# Guía de Implementación Multi-Cámara

## Overview

Esta guía explica la implementación del soporte multi-cámara en el sistema ANPR, permitiendo monitorear múltiples puntos de acceso vehicular simultáneamente.

## Arquitectura Multi-Cámara

```
┌─────────────────────────────────────────────────────────────┐
│              Multi-Camera Manager (Python)                   │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Cámara 1    │  │  Cámara 2    │  │  Cámara N    │     │
│  │  (Entrada)   │  │  (Salida)    │  │  (Personal)  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│         │                  │                  │             │
│         └──────────────────┴──────────────────┘             │
│                            │                                │
│                    ┌───────▼───────┐                          │
│                    │ Pipeline      │                          │
│                    │ Compartido    │                          │
│                    │ (YOLO + OCR)  │                          │
│                    └───────┬───────┘                          │
│                            │                                │
│                    ┌───────▼───────┐                          │
│                    │ Backend API   │                          │
│                    │ (Node.js)     │                          │
│                    └───────┬───────┘                          │
└────────────────────────────────┼──────────────────────────────┘
                                 │
                         ┌───────▼───────┐
                         │ SQL Server    │
                         │ (Estadísticas)│
                         └───────────────┘
```

## Componentes Implementados

### 1. Base de Datos Multi-Cámara

#### Nuevas Tablas

**CameraStreams**: Gestión de streams por cámara
- `camera_id`: ID de la cámara
- `stream_url`: URL del stream RTSP/HTTP
- `stream_type`: Tipo de stream (rtsp, http, webcam)
- `health_status`: Estado de health (healthy, degraded, offline)
- `last_heartbeat`: Último heartbeat recibido

**CameraDetectionStats**: Estadísticas por cámara
- `camera_id`: ID de la cámara
- `date/hour`: Periodo de tiempo
- `detection_count`: Total de detecciones
- `plate_recognized_count`: Placas reconocidas
- `blacklist_match_count`: Matches con lista negra
- `avg_confidence`: Confianza promedio
- `avg_fps`: FPS promedio

#### Actualización de Tabla Camaras

Nuevos campos:
- `priority`: Prioridad de la cámara (1 = más alta)
- `is_active`: Si la cámara está activa
- `current_fps`: FPS actual
- `detection_count`: Total de detecciones
- `region`: Región geográfica

### 2. API Backend Multi-Cámara

#### Nuevos Endpoints

**GET /api/camaras/active**
- Retorna todas las cámaras activas con streams
- Incluye health status y estadísticas

**GET /api/camaras/:id/stats**
- Estadísticas de una cámara específica
- Parámetro `hours` para rango de tiempo

**PUT /api/camaras/:id/health**
- Actualizar health status de una cámara
- Reportado por el servicio ANPR

**POST /api/camaras/:id/detection**
- Registrar detección para estadísticas
- Actualiza contadores en tiempo real

**PUT /api/camaras/:id/toggle**
- Activar/desactivar una cámara
- Solo administradores

**GET /api/camaras/health-summary**
- Resumen de health de todas las cámaras
- Cámaras healthy/degraded/offline

### 3. Multi-Camera Manager (Python)

#### Clases Principales

**CameraProcessor**: Procesador individual por cámara
- Gestión de fuente de video
- Loop de procesamiento independiente
- Estadísticas en tiempo real
- Health monitoring

**MultiCameraManager**: Gestor de múltiples cámaras
- Configuración de cámaras
- Inicio/detenido de procesadores
- Recolección de estadísticas
- Health summary agregado

#### Características

- **Procesamiento Paralelo**: Cada cámara en su propio thread
- **Pipeline Compartido**: Opcional, puede ser individual por cámara
- **Health Monitoring**: Status de cada cámara en tiempo real
- **Priorización**: Cámaras con mayor prioridad procesadas primero
- **Estadísticas**: FPS, detecciones, confianza por cámara

## Configuración

### 1. Ejecutar Migración de Base de Datos

```bash
# Desde el directorio raíz
docker exec -it anpr-db /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C \
  -i /docker-entrypoint-initdb.d/migration_multi_camera.sql
```

### 2. Configurar Cámaras en la Base de Datos

```sql
-- Insertar nuevas cámaras
INSERT INTO Camaras (nombre, ip, rtsp_url, ubicacion, priority, is_active, region)
VALUES 
  ('Entrada Principal', '10.126.9.104', 'rtsp://admin:pass@10.126.9.104:554/stream', 'Acceso Principal', 1, 1, 'Ambato'),
  ('Entrada Secundaria', '10.126.9.105', 'rtsp://admin:pass@10.126.9.105:554/stream', 'Acceso Secundario', 2, 1, 'Ambato'),
  ('Salida Personal', '10.126.9.106', 'rtsp://admin:pass@10.126.9.106:554/stream', 'Salida Personal', 3, 0, 'Ambato');
```

### 3. Configurar Multi-Camera Manager en Python

```python
from app.core.multi_camera_manager import get_multi_camera_manager, CameraConfig

# Obtener gestor
manager = get_multi_camera_manager()

# Agregar cámaras
camera1 = CameraConfig(
    camera_id=1,
    name="Entrada Principal",
    source_type="rtsp",
    source_url="rtsp://admin:pass@10.126.9.104:554/stream",
    priority=1,
    enabled=True,
    region="Ambato"
)

manager.add_camera(camera1)

# Obtener estadísticas
stats = manager.get_all_stats()
print(stats)

# Obtener resumen de health
health_summary = manager.get_health_summary()
print(health_summary)
```

## Uso

### Iniciar Sistema Multi-Cámara

```python
# En el servicio ANPR (main.py)
from app.core.multi_camera_manager import get_multi_camera_manager

# Cargar configuración de cámaras desde la base de datos
cameras = load_cameras_from_db()

manager = get_multi_camera_manager()

for camera_config in cameras:
    manager.add_camera(camera_config)
```

### Monitorear Health de Cámaras

```bash
# Resumen de health
curl http://localhost:5000/api/camaras/health-summary

# Cámaras activas
curl http://localhost:5000/api/camaras/active

# Estadísticas de una cámara específica
curl http://localhost:5000/api/camaras/1/stats?hours=24
```

### Actualizar Health Status

```bash
# El servicio ANPR reporta health status periódicamente
curl -X PUT http://localhost:5000/api/camaras/1/health \
  -H "Content-Type: application/json" \
  -d '{
    "health_status": "healthy",
    "current_fps": 28.5
  }'
```

### Activar/Desactivar Cámaras

```bash
# Desactivar cámara
curl -X PUT http://localhost:5000/api/camaras/1/toggle \
  -H "Content-Type: application/json" \
  -d '{"is_active": false}'

# Activar cámara
curl -X PUT http://localhost:5000/api/camaras/1/toggle \
  -H "Content-Type: application/json" \
  -d '{"is_active": true}'
```

## Frontend Multi-Cámara

### Actualizar Dashboard

```typescript
// Componente Multi-Camera Dashboard
interface Camera {
  id: number;
  name: string;
  status: 'healthy' | 'degraded' | 'offline';
  fps: number;
  detectionCount: number;
}

const MultiCameraDashboard: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null);

  useEffect(() => {
    // Cargar cámaras activas
    fetch('/api/camaras/active')
      .then(res => res.json())
      .then(data => setCameras(data));
  }, []);

  return (
    <div className="multi-camera-dashboard">
      <div className="camera-grid">
        {cameras.map(camera => (
          <CameraCard
            key={camera.id}
            camera={camera}
            onSelect={() => setSelectedCamera(camera.id)}
          />
        ))}
      </div>
      {selectedCamera && (
        <CameraDetail cameraId={selectedCamera} />
      )}
    </div>
  );
};
```

## Estadísticas y Monitoreo

### Métricas por Cámara

Cada cámara reporta:
- **FPS**: Frames por segundo actuales
- **Detecciones**: Total de detecciones
- **Placas Reconocidas**: Total de placas leídas
- **Confianza Promedio**: Calidad de detecciones
- **Health Status**: Estado de la cámara

### Métricas Agregadas

El sistema reporta:
- **Total Cámaras**: Número de cámaras configuradas
- **Cámaras Healthy**: Cámaras funcionando correctamente
- **Cámaras Degraded**: Cámaras con problemas menores
- **Cámaras Offline**: Cámaras no disponibles
- **FPS Promedio**: Promedio de todas las cámaras
- **Total Detecciones**: Suma de todas las cámaras

## Troubleshooting

### Cámara No Conecta

**Síntoma**: Status "offline" en health summary

**Solución**:
1. Verificar que la cámara esté encendida
2. Verificar conectividad de red
3. Validar URL RTSP
4. Revisar credenciales de autenticación
5. Verificar logs del servicio ANPR

### Bajo FPS en Cámara Específica

**Síntoma**: Una cámara tiene FPS muy bajo

**Solución**:
1. Verificar resolución de stream
2. Revisar carga de CPU
3. Verificar ancho de banda de red
4. Considerar desactivar cámaras de baja prioridad

### Health Status Degraded

**Símtoma**: Cámara marcada como "degraded"

**Solución**:
1. Revisar mensajes de error
2. Verificar calidad de stream
3. Revisar logs de procesamiento
4. Considerar reiniciar el procesador de cámara

## Escalabilidad

### Consideraciones de Rendimiento

- **CPU**: Cada cámara adicional consume CPU
- **Memoria**: Cada cámara requiere memoria para buffers
- **Red**: Múltiples streams consumen ancho de banda
- **GPU**: Si está disponible, acelera inferencia

### Recomendaciones

- **2-4 Cámaras**: CPU moderno sin GPU
- **5-8 Cámaras**: CPU moderno con GPU
- **8+ Cámaras**: Hardware dedicado o GPUs múltiples

### Optimización

- Usar pipeline compartido cuando sea posible
- Priorizar cámaras críticas
- Desactivar cámaras no esenciales
- Ajustar resolución de streams
- Usar cuantización de modelos

## Seguridad

### Autenticación de Streams

- No hardcodear credenciales
- Usar variables de entorno
- Rotar credenciales regularmente
- Usar HTTPS/TLS cuando sea posible

### Control de Acceso

- Solo administradores pueden activar/desactivar cámaras
- Auditoría de cambios de configuración
- Logs de acceso a cámaras

## Referencias

- [RTSP Documentation](https://en.wikipedia.org/wiki/Real_Time_Streaming_Protocol)
- [OpenCV Video I/O](https://docs.opencv.org/4.x/dd/d43/tutorial_py_video_display.html)
- [Multi-threading in Python](https://docs.python.org/3/library/threading.html)