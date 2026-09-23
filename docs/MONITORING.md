# Guía de Monitoreo con Prometheus y Grafana

## Overview

Esta guía explica la implementación del sistema de monitoreo con Prometheus y Grafana para el sistema ANPR del ECU 911 Zona 3.

## Arquitectura de Monitoreo

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Aplicaciones  │         │   Prometheus    │         │    Grafana      │
│   (Metrics)     │         │   (Collector)   │         │   (Dashboard)   │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                          │                          │
         │ /metrics                 │ scrape                  │ query
         │─────────────────────────>│                          │
         │                          │─────────────────────────>│
         │                          │                          │
         │                          │ alerts                  │
         │                          │─────────────────────────>│
```

## Componentes de Monitoreo

### 1. Prometheus

**Puerto**: 9090

**Función**: Recolecta y almacena métricas de tiempo serie

**Configuración**: `monitoring/prometheus/prometheus.yml`

**Características**:
- Scrape interval: 15 segundos
- Retención de datos: 30 días
- Alertas configuradas en `monitoring/prometheus/rules/`

### 2. Grafana

**Puerto**: 3001 (mapeado a 3000 internamente)

**Credenciales por defecto**:
- Usuario: `admin`
- Contraseña: valor de `GRAFANA_ADMIN_PASSWORD` en el `.env` de la raíz

**Función**: Visualización de métricas y dashboards

**Configuración**: `monitoring/grafana/provisioning/`

## Métricas Implementadas

### Backend Node.js

#### Métricas HTTP
- `anpr_http_request_duration_seconds`: Duración de solicitudes HTTP
- `anpr_http_requests_total`: Total de solicitudes HTTP
- `anpr_http_requests_in_progress`: Solicitudes en progreso

#### Métricas de Base de Datos
- `anpr_db_query_duration_seconds`: Duración de consultas
- `anpr_db_queries_total`: Total de consultas
- `anpr_db_connections_active`: Conexiones activas

#### Métricas de Caché
- `anpr_cache_hits_total`: Hits en caché
- `anpr_cache_misses_total`: Misses en caché
- `anpr_cache_operations_duration_seconds`: Duración de operaciones

#### Métricas de WebSockets
- `anpr_websocket_connections`: Conexiones activas
- `anpr_websocket_messages_total`: Mensajes enviados/recibidos
- `anpr_websocket_errors_total`: Errores de WebSocket

#### Métricas de Negocio
- `anpr_detections_total`: Detecciones de placas
- `anpr_blacklist_checks_total`: Verificaciones de lista negra
- `anpr_authorized_checks_total`: Verificaciones de lista blanca

### Microservicio ANPR Python

#### Métricas de Inferencia
- `anpr_inference_duration_seconds`: Duración de inferencia YOLO
- `anpr_ocr_duration_seconds`: Duración de OCR
- `anpr_frame_processing_duration_seconds`: Procesamiento de frames

#### Métricas de Rendimiento
- `anpr_fps`: FPS actual del servicio
- `anpr_detection_confidence`: Confianza de detección
- `anpr_ocr_confidence`: Confianza de OCR

#### Métricas de Negocio
- `anpr_detections_total`: Detecciones de placas
- `anpr_plates_recognized_total`: Placas reconocidas
- `anpr_tracking_active`: Tracks activos

## Alertas Configuradas

### Alertas Críticas

1. **BackendServiceDown**: Servicio backend caído (> 1 min)
2. **ANPRServiceDown**: Servicio ANPR caído (> 1 min)
3. **RedisServiceDown**: Servicio Redis caído (> 1 min)
4. **DatabaseConnectionPoolExhausted**: Pool de conexiones agotado (> 90%)

### Alertas de Advertencia

1. **HighBackendLatency**: Alta latencia en backend (> 1s)
2. **HighBackendErrorRate**: Alta tasa de errores (> 5%)
3. **HighANPRLatency**: Alta latencia en ANPR (> 2s)
4. **LowANPRFPS**: Bajo FPS en ANPR (< 20 FPS)
5. **HighBackendMemory**: Alta memoria en backend (> 1 GB)
6. **HighBackendCPU**: Alta CPU en backend (> 80%)
7. **HighRedisMemory**: Alta memoria en Redis (> 90%)

### Alertas Informativas

1. **LowCacheHitRatio**: Bajo hit ratio de caché (< 50%)
2. **HighDatabaseLatency**: Alta latencia en BD (> 1s)
3. **DiskSpaceLow**: Espacio en disco bajo (< 10%)
4. **HighSystemLoad**: Alta carga del sistema (> 2)

## Acceso a las Herramientas

### Prometheus UI

```
URL: http://localhost:9090
```

**Funciones**:
- Consultar métricas con PromQL
- Ver targets y estado de scrape
- Configurar y probar alertas
- Ejecutar consultas ad-hoc

### Grafana Dashboard

```
URL: http://localhost:3001
Usuario: admin
Contraseña: (GRAFANA_ADMIN_PASSWORD del .env de la raíz)
```

**Funciones**:
- Visualizar dashboards preconfigurados
- Crear dashboards personalizados
- Configurar notificaciones
- Exportar/importar dashboards

## Consultas PromQL Útiles

### Backend Performance

```promql
# Latencia promedio del backend
rate(anpr_http_request_duration_seconds_sum[5m]) / rate(anpr_http_request_duration_seconds_count[5m])

# Tasa de errores
rate(anpr_http_requests_total{status=~"5.."}[5m])

# Solicitudes por segundo
rate(anpr_http_requests_total[1m])
```

### ANPR Performance

```promql
# FPS actual
anpr_fps

# Latencia de inferencia
rate(anpr_inference_duration_seconds_sum[5m]) / rate(anpr_inference_duration_seconds_count[5m])

# Latencia de OCR
rate(anpr_ocr_duration_seconds_sum[5m]) / rate(anpr_ocr_duration_seconds_count[5m])
```

### Caché Performance

```promql
# Hit ratio de caché
rate(anpr_cache_hits_total[5m]) / (rate(anpr_cache_hits_total[5m]) + rate(anpr_cache_misses_total[5m]))

# Operaciones de caché por segundo
rate(anpr_cache_hits_total[1m]) + rate(anpr_cache_misses_total[1m])
```

### Detecciones

```promql
# Detecciones por minuto
rate(anpr_detections_total[1m])

# Detecciones exitosas
rate(anpr_detections_total{status="success"}[1m])

# Tracks activos
anpr_tracking_active
```

## Dashboards Recomendados

### Dashboard Principal (Sistema ANPR)

**Panel 1: Estado de Servicios**
- Estado de Backend (up/down)
- Estado de ANPR (up/down)
- Estado de Redis (up/down)
- Estado de BD (up/down)

**Panel 2: Rendimiento de Backend**
- Latencia HTTP (p50, p95, p99)
- Tasa de solicitudes (req/s)
- Tasa de errores (%)
- Solicitudes en progreso

**Panel 3: Rendimiento ANPR**
- FPS actual
- Latencia de inferencia
- Latencia de OCR
- Tracks activos

**Panel 4: Calidad de Detección**
- Detecciones totales
- Placas reconocidas
- Confianza promedio
- Detecciones fallidas

**Panel 5: Caché**
- Hit ratio (%)
- Operaciones/s
- Tiempo de operación
- Memoria usada

**Panel 6: Recursos del Sistema**
- CPU (%)
- Memoria (GB)
- Disco (%)
- Conexiones de red

### Dashboard de Alertas

**Panel 1: Alertas Activas**
- Alertas críticas
- Alertas de advertencia
- Alertas informativas
- Historial de alertas

**Panel 2: Tendencias**
- Tasa de alertas por hora
- Alertas por servicio
- Tiempo de resolución
- Falsos positivos

## Configuración de Notificaciones

### Email (Opcional)

Para configurar notificaciones por email, agregar AlertManager:

```yaml
# docker-compose.yml
alertmanager:
  image: prom/alertmanager:latest
  ports:
    - "9093:9093"
  volumes:
    - ./monitoring/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml
```

### Slack (Opcional)

Configurar webhook de Slack en AlertManager:

```yaml
# alertmanager.yml
receivers:
  - name: 'slack-notifications'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#anpr-alerts'
```

## Solución de Problemas

### Prometheus no recolecta métricas

**Síntoma**: Targets en estado "DOWN"

**Solución**:
1. Verificar que los servicios estén corriendo
2. Verificar conectividad de red
3. Revisar logs de Prometheus
4. Verificar configuración de scrape

### Métricas no aparecen en Grafana

**Síntoma**: Dashboards vacíos o sin datos

**Solución**:
1. Verificar que Prometheus esté recolectando métricas
2. Verificar configuración de datasource en Grafana
3. Revisar consultas PromQL
4. Verificar rango de tiempo seleccionado

### Alertas no se disparan

**Síntoma**: Condiciones de alerta se cumplen pero no se dispara

**Solución**:
1. Verificar configuración de reglas
2. Revisar duración `for` en la regla
3. Verificar que las métricas existan
4. Revisar logs de Prometheus

### Alto consumo de recursos

**Síntoma**: Prometheus consume mucha CPU/memoria

**Solución**:
1. Aumentar intervalo de scrape
2. Reducir retención de datos
3. Optimizar consultas
4. Considerar cardinalidad de métricas

## Mantenimiento

### Limpieza de Datos Antiguos

Prometheus retiene datos por 30 días por defecto. Para ajustar:

```yaml
# prometheus.yml
command:
  - '--storage.tsdb.retention.time=30d'  # Ajustar según necesidad
```

### Backup de Configuración

```bash
# Backup de configuración de Prometheus
cp monitoring/prometheus/prometheus.yml monitoring/prometheus/prometheus.yml.backup

# Backup de dashboards de Grafana
docker exec anpr-grafana grafana-cli admin export-dashboard > dashboard-backup.json
```

### Actualización de Dashboards

Los dashboards se actualizan automáticamente desde:
- `monitoring/grafana/dashboards/`

Para agregar nuevos dashboards:
1. Crear archivo JSON en `monitoring/grafana/dashboards/`
2. Reiniciar contenedor de Grafana

## Seguridad

### Protección con Contraseña

Cambiar credenciales por defecto de Grafana:

```yaml
# docker-compose.yml
environment:
  - GF_SECURITY_ADMIN_USER=nuevo_usuario
  - GF_SECURITY_ADMIN_PASSWORD=nueva_contraseña_segura
```

### Restricción de Acceso

Usar reverse proxy (nginx) para restringir acceso:

```nginx
location /prometheus/ {
    auth_basic "Prometheus";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://prometheus:9090/;
}
```

### HTTPS

Configurar TLS/SSL para acceso seguro:
- Usar certificados Let's Encrypt
- Configurar nginx con HTTPS
- Redirigir HTTP a HTTPS

## Referencias

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [PromQL Query Language](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Best Practices for Monitoring](https://prometheus.io/docs/practices/)