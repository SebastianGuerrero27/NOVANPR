# Guía de Implementación de Caché Distribuido con Redis

## Overview

Esta guía explica la implementación del caché distribuido con Redis en el sistema ANPR para mejorar el rendimiento y reducir la carga en la base de datos.

## Arquitectura del Caché

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Frontend      │         │   Backend       │         │   Redis         │
│   (React)       │         │   (Node.js)     │         │   (Cache)       │
└────────┬────────┘         └────────┬────────┘         └────────┬────────┘
         │                          │                          │
         │ HTTP API                 │ GET/SET                  │
         │─────────────────────────>│─────────────────────────>│
         │                          │                          │
         │                          │<─────────────────────────│
         │<─────────────────────────│ Cache Hit/Miss           │
         │                          │                          │
         │                          │                          │
         │                          │ FALLBACK                 │
         │                          │─────────────────────────>│
         │                          │ SQL Server                │
         │                          │<─────────────────────────│
         │                          │                          │
```

## Configuración

### Variables de Entorno

Agregar las siguientes variables al archivo `.env` del backend:

```bash
# Configuración Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
ENABLE_REDIS_CACHE=true
CACHE_TTL_SECONDS=3600
```

### Docker Compose

El servicio Redis ya está configurado en `docker-compose.yml`:

```yaml
redis:
  image: redis:7-alpine
  container_name: anpr-redis
  ports:
    - "6379:6379"
  volumes:
    - redis_data:/data
  command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
  restart: always
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 5s
    retries: 5
```

## Estrategias de Caché Implementadas

### 1. Caché de Lista Negra

**Uso**: Almacenar la lista de vehículos en lista negra

**TTL**: 5 minutos (300 segundos)

**Invalidación**: Automática al agregar/eliminar vehículos

```typescript
// Obtener del caché
const blacklist = await cacheHelper.getBlacklist();

// Guardar en caché
await cacheHelper.setBlacklist(blacklist, 300);

// Invalidar caché
await cacheHelper.invalidateBlacklist();
```

### 2. Caché de Vehículos Autorizados

**Uso**: Almacenar la lista blanca de vehículos autorizados

**TTL**: 5 minutos (300 segundos)

**Invalidación**: Automática al agregar/eliminar vehículos

```typescript
// Obtener del caché
const vehicles = await cacheHelper.getAuthorizedVehicles();

// Guardar en caché
await cacheHelper.setAuthorizedVehicles(vehicles, 300);

// Invalidar caché
await cacheHelper.invalidateAuthorizedVehicles();
```

### 3. Caché de Sesiones

**Uso**: Almacenar sesiones de usuarios autenticados

**TTL**: 1 hora (3600 segundos)

**Invalidación**: Al cerrar sesión o expirar token

```typescript
// Obtener sesión
const session = await cacheHelper.getSession(userId);

// Guardar sesión
await cacheHelper.setSession(userId, sessionData, 3600);

// Eliminar sesión
await cacheHelper.deleteSession(userId);
```

### 4. Rate Limiting

**Uso**: Limitar solicitudes por usuario/IP

**TTL**: Variable según la ventana de tiempo

```typescript
// Verificar rate limit
const allowed = await cacheHelper.checkRateLimit(identifier, limit, window);
```

### 5. Caché de Detecciones Recientes

**Uso**: Almacenar las últimas detecciones para dashboard

**TTL**: 1 minuto (60 segundos)

```typescript
// Obtener detecciones recientes
const detections = await cacheHelper.getRecentDetections(100);

// Guardar detecciones
await cacheHelper.setRecentDetections(detections, 60);
```

## API de Administración de Caché

### Obtener Estadísticas

```http
GET /api/cache/stats
Authorization: Bearer <token>
```

**Response:**
```json
{
  "available": true,
  "stats": {
    "connected": true,
    "keyspace": "db0:keys=123,expires=45,avg_ttl=3600"
  }
}
```

### Limpiar Todo el Caché

```http
DELETE /api/cache/flush
Authorization: Bearer <token>
```

**Response:**
```json
{
  "message": "Caché limpiado exitosamente."
}
```

### Invalidar Caché de Lista Negra

```http
DELETE /api/cache/blacklist
Authorization: Bearer <token>
```

**Response:**
```json
{
  "message": "Caché de lista negra invalidado."
}
```

### Invalidar Caché de Vehículos Autorizados

```http
DELETE /api/cache/authorized
Authorization: Bearer <token>
```

**Response:**
```json
{
  "message": "Caché de vehículos autorizados invalidado."
}
```

### Eliminar Claves por Patrón

```http
DELETE /api/cache/pattern/:pattern
Authorization: Bearer <token>
```

**Response:**
```json
{
  "message": "Eliminadas 15 claves con patrón session:*."
}
```

## Uso Programático

### Servicio de Caché Básico

```typescript
import { cacheService } from '../services/cache';

// Verificar disponibilidad
if (cacheService.isAvailable()) {
  // Obtener valor
  const value = await cacheService.get<T>('mi_clave');
  
  // Guardar valor
  await cacheService.set('mi_clave', valor, 3600);
  
  // Eliminar clave
  await cacheService.delete('mi_clave');
  
  // Verificar existencia
  const exists = await cacheService.exists('mi_clave');
}
```

### Helpers Especializados

```typescript
import { cacheHelper } from '../services/cache';

// Sesiones
await cacheHelper.setSession(userId, sessionData);
const session = await cacheHelper.getSession(userId);
await cacheHelper.deleteSession(userId);

// Lista Negra
await cacheHelper.setBlacklist(blacklistData);
const blacklist = await cacheHelper.getBlacklist();
await cacheHelper.invalidateBlacklist();

// Vehículos Autorizados
await cacheHelper.setAuthorizedVehicles(vehicles);
const vehicles = await cacheHelper.getAuthorizedVehicles();
await cacheHelper.invalidateAuthorizedVehicles();

// Rate Limiting
const allowed = await cacheHelper.checkRateLimit('user_123', 100, 60);

// Detecciones Recientes
await cacheHelper.setRecentDetections(detections);
const recent = await cacheHelper.getRecentDetections(100);
```

## Monitoreo y Debugging

### Verificar Conexión Redis

```bash
# Desde el contenedor backend
docker exec -it anpr-backend redis-cli -h redis ping

# Output esperado: PONG
```

### Ver Claves Almacenadas

```bash
# Listar todas las claves
docker exec -it anpr-redis redis-cli KEYS '*'

# Listar claves de sesión
docker exec -it anpr-redis redis-cli KEYS 'session:*'

# Ver valor de una clave
docker exec -it anpr-redis redis-cli GET 'blacklist:all'
```

### Ver Estadísticas

```bash
docker exec -it anpr-redis redis-cli INFO stats
docker exec -it anpr-redis redis-cli INFO keyspace
```

### Monitorear en Tiempo Real

```bash
docker exec -it anpr-redis redis-cli MONITOR
```

## Rendimiento y Optimización

### Políticas de Memoria

Redis está configurado con:
- **Memoria máxima**: 256 MB
- **Política de evicción**: `allkeys-lru` (Least Recently Used)
- **Persistencia**: AOF (Append Only File) activado

### TTL Recomendados

| Tipo de Datos | TTL Recomendado | Justificación |
|--------------|-----------------|----------------|
| Lista Negra | 300s (5 min) | Datos que cambian frecuentemente |
| Vehículos Autorizados | 300s (5 min) | Datos que cambian frecuentemente |
| Sesiones | 3600s (1 hora) | Balance entre seguridad y rendimiento |
| Detecciones Recientes | 60s (1 min) | Datos muy volátiles |
| Rate Limiting | Variable | Según ventana de tiempo |

### Mejores Prácticas

1. **Invalidación Proactiva**: Invalidar caché cuando los datos cambian
2. **TTL Apropiado**: Usar TTL según la volatilidad de los datos
3. **Fallback a BD**: Siempre tener fallback a base de datos
4. **Monitoreo**: Monitorear hit ratio de caché
5. **No Cachear Datos Sensibles**: Nunca cachear contraseñas o tokens

## Troubleshooting

### Redis No Disponible

**Síntoma**: Las aplicaciones funcionan pero más lento

**Solución**: 
1. Verificar que el contenedor Redis está corriendo
2. Verificar conectividad desde backend
3. Revisar logs de Redis

### Caché No Se Actualiza

**Síntoma**: Datos antiguos en el caché

**Solución**:
1. Verificar que la invalidación se está llamando
2. Usar el endpoint de administración para limpiar caché
3. Revisar TTL configurado

### Alta Memoria en Redis

**Síntoma**: Redis consume mucha memoria

**Solución**:
1. Reducir TTL de claves
2. Ajustar política de evicción
3. Limpiar claves no usadas con patrón

### Conexión Rechazada

**Síntoma**: Error de conexión a Redis

**Solución**:
1. Verificar configuración de REDIS_HOST/PORT
2. Verificar que no haya firewall bloqueando
3. Revisar credenciales si hay password

## Seguridad

### Configuración de Seguridad

1. **Password**: Configurar `REDIS_PASSWORD` en producción
2. **Red**: Usar redes Docker aisladas
3. **TLS**: Considerar TLS para entornos de producción
4. **Comandos Peligrosos**: Deshabilitar comandos como FLUSHDB en producción

### Variables Sensibles

Nunca incluir passwords en el código. Usar siempre variables de entorno:

```bash
# .env (nunca commit al repo)
REDIS_PASSWORD=tu_password_secreto
```

## Escalabilidad

### Redis Cluster

Para entornos de producción con alta carga, considerar:

1. **Redis Sentinel**: Para alta disponibilidad
2. **Redis Cluster**: Para escalabilidad horizontal
3. **Redis Enterprise**: Para características avanzadas

### Estrategias de Escalado

1. **Separación de Cachés**: Usar diferentes instancias para diferentes tipos de datos
2. **Sharding**: Distribuir claves entre múltiples instancias
3. **Read Replicas**: Para lecturas de alta frecuencia

## Referencias

- [Redis Documentation](https://redis.io/documentation)
- [ioredis Documentation](https://github.com/luin/ioredis)
- [Redis Best Practices](https://redis.io/topics/best-practices)