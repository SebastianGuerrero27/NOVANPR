# Roles, permisos y control de acceso de placas

## 1. Modelo: RBAC por permisos

El sistema aplica control de acceso basado en roles según el modelo de referencia NIST
(Sandhu et al., 1996; Ferraiolo et al., 2001; ANSI INCITS 359-2004):

```
usuario ──(1 rol)──▶ rol ──(n permisos)──▶ permiso (recurso:acción)
```

- **Fuente única de verdad:** `backend/src/dominio/permisos.ts` define el catálogo de permisos y la
  matriz rol → permiso. Antes, unas 20 comprobaciones de roles (`['Admin', 'Supervisor']`)
  estaban repartidas entre rutas y pantallas. Ahora los endpoints exigen permisos
  (`requierePermiso('padron:gestionar')`) y el frontend consulta `puede(...)` con los permisos que
  entrega `/api/auth/me`. Agregar un rol o mover una capacidad es un cambio de una línea.
- **Verificación en cada solicitud:** el rol vigente se relee de la base (con caché de 20 s), así
  que un cambio de rol o un bloqueo surte efecto en segundos. Además se cierran las conexiones
  Socket.IO de la cuenta para que reconecte a las salas que le corresponden.
- **Pruebas:** la matriz se verifica con una tabla de verdad (`src/tests/dominio/permisos.test.ts`) y
  de extremo a extremo con 52 casos rol × endpoint (`src/tests/integration/api.test.ts`).

## 2. Roles

Solo existen **tres roles** (migración `db/migration_v6_tres_roles.sql`: `OPERADOR` → `GUARDIA`,
`GESTOR_ACCESOS` → `GESTOR_PERMISOS`; las cuentas `SUPERVISOR` pasan a `GUARDIA` por mínimo privilegio).

| Rol | Código | Propósito |
|---|---|---|
| **Guardia** | `GUARDIA` | Punto de control: monitoreo en vivo, validación de lecturas, registro manual y solicitudes de acceso. Recibe el aviso a pantalla completa con el protocolo y la notificación **"Se ha otorgado permiso a … con vehículo de placa …"**, que abre la lista blanca filtrada por la placa. |
| **Gestor de permisos** | `GESTOR_PERMISOS` | Otorga los **permisos de placa** (lista blanca): categoría, vigencia y franjas horarias; resuelve las solicitudes de acceso. Trabaja en **una sola vista** (*Gestión de permisos*), sin monitoreo en vivo. No recibe avisos de monitoreo: solo la **llegada del vehículo** al que dio permiso, además de las solicitudes nuevas y los permisos por vencer. |
| **Administrador** | `ADMIN` | Todos los permisos: usuarios, cámaras, configuración, auditoría, lista de alertas, excepciones de acceso, reportes, evaluación y alarmas escaladas. |

## 3. Matriz rol → permiso

| Permiso | Guardia | Gestor de permisos | Admin |
|---|:-:|:-:|:-:|
| `operacion:monitorear` — monitoreo, inicio, registro de ingresos | ✓ | | ✓ |
| `detecciones:validar` — confirmar/corregir lecturas, registro manual | ✓ | | ✓ |
| `listas:ver` — consultar lista blanca y lista de alertas | ✓ | ✓ | ✓ |
| `solicitudes:crear` — solicitar la autorización de una placa | ✓ | | ✓ |
| `padron:gestionar` — permisos de placa (vigencia, horario, categoría) | | ✓ | ✓ |
| `solicitudes:resolver` — aprobar o rechazar solicitudes | | ✓ | ✓ |
| `avisos:garita` — aviso a pantalla completa con protocolo | ✓ | | ✓ |
| `avisos:acceso` — accesos denegados/restringidos, reincidencias | ✓ | | ✓ |
| `avisos:seguridad` — placas en lista de alertas | ✓ | | ✓ |
| `avisos:padron` — permisos de placa otorgados | ✓ | | ✓ |
| `accesos:excepcion`, `alertas:gestionar`, `avisos:sistema`, `alarmas:escalamiento`, `reportes:ver`, `evaluacion:ver`, `camaras:operar`, `detecciones:eliminar`, `camaras:gestionar`, `usuarios:gestionar`, `auditoria:ver`, `configuracion:gestionar`, `propietario:consultar` | | | ✓ |

### Flujo de notificaciones de permisos

1. El **gestor de permisos** registra un permiso (o aprueba una solicitud) → notificación
   `padron.permiso_otorgado` a quienes tienen `avisos:padron` (guardias y administradores), excepto
   a quien lo otorgó. Enlace: `/listas/autorizados?q=<placa>`.
2. Llega el vehículo y el paso queda **autorizado** (lectura automática, validación o registro
   manual) → notificación `acceso.llegada_permiso` **solo** al usuario que otorgó el permiso
   (`VehiculosAutorizados.registrado_por`). Las entradas repetidas dentro de 30 min se agrupan.

El enrutamiento de notificaciones también se hace **por permiso** (no por rol): cada tipo de
notificación declara el permiso de sus destinatarios (ver [NOTIFICACIONES.md](NOTIFICACIONES.md)).

## 4. Separación de funciones (SoD)

Principio de los "cuatro ojos" (SoD dinámica del modelo NIST): **quien registra una solicitud de
acceso no puede resolverla**, aunque su rol tenga `solicitudes:resolver`. Se aplica en la API
(`UPDATE … WHERE solicitado_por <> @uid`, reclamación atómica) y la interfaz no le ofrece la acción.
Las demás decisiones sensibles quedan auditadas con su autor: alta/edición/retiro de permisos,
aprobación o rechazo, excepciones (`EXCEPCION_ACCESO`) y validaciones.

## 5. Permisos de placa con restricciones temporales (TRBAC)

Cada registro del padrón es un permiso de ingreso con:

| Campo | Significado |
|---|---|
| `categoria` | FUNCIONARIO, VISITANTE, PROVEEDOR, CONTRATISTA, OFICIAL, EMERGENCIA |
| `fecha_inicio` | Primer día de vigencia (vacío = desde ya) |
| `fecha_vencimiento` | Último día de vigencia (vacío = sin vencimiento) |
| `horario` | Franjas `[{"dias":[1..7],"desde":"HH:MM","hasta":"HH:MM"}]` (ISO 8601: 1 = lunes). Una franja con `hasta ≤ desde` cruza la medianoche. Vacío = 24/7 |

Es la adaptación a placas del **RBAC temporal** (TRBAC, Bertino et al., 2001; GTRBAC, Joshi et al.,
2005): el permiso se habilita solo dentro de intervalos periódicos. La evaluación es una función pura
(`dominio/horario.ts → evaluarVigencia`) en la zona horaria institucional y devuelve
`vigente | no_iniciada | vencida | fuera_horario`. Equivale a los perfiles horarios ("time
profiles") de los sistemas comerciales de control de acceso vehicular.

Un permiso existente que no está vigente **no concede el paso** (regla R2 de la política de decisión):
el ingreso queda `no_reconocido` con `restriccion_acceso`, el personal ve el motivo concreto
("fuera de horario: L–V 07:00–19:00") y el gestor de accesos recibe una notificación. Solo quien tiene
`accesos:excepcion` puede conceder ese paso concreto, con motivo obligatorio y auditado.

## 6. Flujo de solicitudes de acceso

```mermaid
sequenceDiagram
  participant G as Garita (Guardia)
  participant API as Backend
  participant GA as Gestor de permisos
  G->>API: Vehículo sin permiso → "Solicitar autorización" (POST /api/solicitudes-acceso)
  API-->>GA: notificación solicitud.nueva (Socket.IO + Web Push)
  GA->>API: Aprobar con vigencia/horario (POST /:id/aprobar)  — SoD: GA ≠ solicitante
  API->>API: crea, reactiva o amplía el permiso; opcionalmente valida el ingreso
  API-->>G: notificación solicitud.resuelta + aviso "acceso autorizado"
```

## Referencias

- Sandhu, R., Coyne, E., Feinstein, H., & Youman, C. (1996). Role-based access control models. *IEEE Computer, 29*(2), 38–47.
- Ferraiolo, D., Sandhu, R., Gavrila, S., Kuhn, D. R., & Chandramouli, R. (2001). Proposed NIST standard for role-based access control. *ACM TISSEC, 4*(3), 224–274.
- Bertino, E., Bonatti, P., & Ferrari, E. (2001). TRBAC: A temporal role-based access control model. *ACM TISSEC, 4*(3), 191–233.
- Joshi, J., Bertino, E., Latif, U., & Ghafoor, A. (2005). A generalized temporal role-based access control model. *IEEE TKDE, 17*(1), 4–23.
- Hu, V. C., et al. (2014). *Guide to Attribute Based Access Control (ABAC) Definition and Considerations* (NIST SP 800-162).
