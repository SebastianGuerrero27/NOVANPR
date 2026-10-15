# Recorrido de un paso vehicular: de la cámara al registro

Recorrido del sistema vigente (14 de octubre de 2026). Reemplaza la descripción original de la
arquitectura de dos fases (PaddleOCR asíncrono, 30 FPS y video MJPEG), que ya no corresponde al
código. Las «dos fases» se conservan en la API: el motor crea el ingreso (`/detecciones/ingreso`) y
luego lo completa con la lectura (`/detecciones/completar-ocr`); desde octubre de 2026 existe además
una tercera llamada opcional, la reevaluación tardía (`/detecciones/reevaluar`).

## 1. Diagrama

```mermaid
sequenceDiagram
    autonumber
    participant Cam as Cámara IP (flujo principal)
    participant MTX as MediaMTX
    participant Mot as Motor ANPR (FastAPI)
    participant API as Backend (Express)
    participant DB as SQL Server
    participant UI as Navegador (React)

    Cam->>MTX: RTSP (H.265 o H.264, 1080p)
    MTX->>Mot: RTSP interno (cola de un cuadro: siempre el más reciente)
    MTX->>UI: WebRTC/WHEP del flujo secundario (vista en vivo)
    Mot->>Mot: Compuerta de movimiento y zonas → detector YOLO26n → seguimiento (Kalman)
    Mot->>UI: Cajas de las pistas por WebSocket (~10 envíos/s, HUD sobre el video)
    Mot->>Mot: OCR rápido por pista (consenso) y selección del mejor cuadro
    Mot->>Mot: En paralelo: OCR profundo, verificador PP-OCRv6, atributos del vehículo
    Note over Mot: Plazo de registro: 1 s desde la foto (REGISTRO_MAX_MS)
    Mot->>API: POST /detecciones/ingreso (fotos, cámara, tracking)
    API->>DB: ¿Mismo paso? (misma placa y cámara en 35 s) → nuevo ingreso o consolidado
    Mot->>API: POST /detecciones/completar-ocr (placa, confianza, validez E1–E5, evidencia)
    API->>API: Decisión R1–R7 con lista negra y lista blanca (vigencia y horario)
    API->>DB: Estado: autorizado · pendiente de revisión · no registrado · alerta
    API-->>UI: Socket.IO (deteccion:nueva/actualizada) y notificación persistente (+ Web Push)
    opt El verificador o el vehículo llegan después del plazo
        Mot->>API: POST /detecciones/reevaluar
        API->>API: Misma regla; avisa solo si la decisión cambia
    end
```

## 2. Componentes

| Componente | Archivo | Responsabilidad |
|---|---|---|
| Motor en tiempo real | `services/anpr/app/aplicacion/motor.py` | Captura, compuerta, detección, seguimiento, lectura en vivo, registro en menos de 1 s, reevaluación, deduplicación y descartes auditados |
| Movimiento y zonas | `services/anpr/app/aplicacion/movimiento.py` | Compuerta de inferencia, MOG2, área de detección y zonas de exclusión |
| Verificación de la lectura | `services/anpr/app/aplicacion/verificacion_placa.py` | Fila de caracteres, bordes de la placa y evidencias E1–E5 |
| Interpretación de la placa | `services/anpr/app/dominio/interpretacion_placa.py` | Formato ANT que explica la lectura con menos sustituciones; nunca agrega ni quita caracteres |
| Casos de uso del backend | `backend/src/aplicacion/detecciones.ts` | `ingreso`, `completarOcr`, `reevaluar`, validación manual y eliminación |
| Política de acceso | `backend/src/dominio/decisionAcceso.ts` | Regla R1–R7 como función pura |
| Persistencia | `backend/src/infraestructura/persistencia/deteccionesSql.ts` | Un paso = un registro (ventana de 35 000 ms por placa y cámara) |
| Interfaz | `frontend/src/interfaz/paginas/Monitoreo.tsx`, `Inicio.tsx`, `DetalleDeteccion.tsx` | Video con HUD, feed en tiempo real, dashboard con los 50 ingresos recientes y detalle con la evidencia |
| Foto de la placa | `frontend/src/interfaz/componentes/deteccion.tsx` (`PlacaFoto`) | La placa se muestra con la foto real del recorte, nunca dibujada |

## 3. Qué ve el personal

| Momento | Pantalla |
|---|---|
| La placa entra al cuadro | HUD ámbar «ESCANEANDO OCR» sobre la placa seguida |
| El OCR rápido la lee | HUD verde con la placa y la confianza del consenso |
| El paso se registra (< 1 s desde la foto) | Fila nueva en el feed y en el dashboard, con la foto del recorte; insignia del estado |
| Alerta o vehículo no registrado | Aviso a pantalla completa con protocolo, sonido y notificación |
| Lectura dudosa | Insignia «POR CONFIRMAR»: el guardia confirma o corrige con la evidencia |
| Reevaluación | El estado cambia si el segundo OCR o el vehículo modifican la decisión, y se avisa |

## 4. Cómo ejecutarlo

Todo el sistema se levanta con Docker Compose; el procedimiento completo, la instalación en otro
equipo y los problemas frecuentes están en [EJECUTAR_SISTEMA.md](EJECUTAR_SISTEMA.md).

```bash
docker compose up -d --build
# Frontend http://localhost:3000 · API http://localhost:5000 · Motor http://localhost:8000
```

Las mediciones de latencia, la deduplicación y los A/B del motor están en
[docs/AUDITORIA_MOTOR_ANPR.md](docs/AUDITORIA_MOTOR_ANPR.md); el método de validez en
[docs/METODO_VERIFICACION_LECTURA.md](docs/METODO_VERIFICACION_LECTURA.md).
