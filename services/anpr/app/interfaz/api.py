"""
Servidor HTTP y WebSocket del motor ANPR (capa de interfaz).

Las rutas solo verifican el acceso, leen la petición y delegan en `MotorAnpr`
(app/aplicacion/motor.py); no guardan estado propio. `crear_app(motor)` permite construir el
servidor con un motor de prueba.

Acceso (app/infraestructura/acceso.py):
  - Control (cambio de cámara, región de interés, MJPEG de depuración): encabezado
    X-Servicio-Token, que solo conoce el backend.
  - Video y pistas: ticket de 60 s emitido por el backend a un usuario con sesión.

La única entrada de video es la cámara RTSP asignada por el backend (su ruta en MediaMTX): el motor
no recibe cuadros del navegador ni abre conexiones a URLs arbitrarias.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse

from app.aplicacion.motor import MotorAnpr
from app.infraestructura.acceso import ticket_valido, token_servicio_valido
from app.infraestructura.debug_stream import _get_standby_jpeg, mjpeg_generator
from app.infraestructura.logger import get_logger
from app.infraestructura.metrics import get_metrics

logger = get_logger("api")

SIN_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"}


def _denegado() -> JSONResponse:
    return JSONResponse({"error": "Token de servicio requerido"}, status_code=401)


def _param_int(websocket: WebSocket, nombre: str, defecto: int, minimo: int, maximo: int) -> int:
    try:
        return max(minimo, min(maximo, int(websocket.query_params.get(nombre, defecto))))
    except (TypeError, ValueError):
        return defecto


def crear_app(motor: MotorAnpr) -> FastAPI:
    @asynccontextmanager
    async def ciclo_de_vida(_app: FastAPI):
        motor.iniciar()
        yield
        motor.detener()

    app = FastAPI(
        title="ECU 911 ANPR Microservice",
        description="Microservicio de Reconocimiento de Placas — Arquitectura de Dos Fases",
        version="2.0.0",
        lifespan=ciclo_de_vida,
    )
    # Sin CORS: el navegador solo abre los WebSocket con ticket (/ws/pistas, /ws/stream), que no lo
    # usan; el estado y el control los consulta el backend. Así ninguna página de otro sitio puede
    # leer el estado del motor desde el navegador de un operador. La evidencia fotográfica se sirve
    # solo desde el backend, con enlaces firmados.

    @app.websocket("/ws/stream")
    @app.websocket("/api/ws/stream")
    async def video_en_vivo(websocket: WebSocket):
        """
        Video anotado en vivo para el monitoreo (JPEG binario por WebSocket).

          ticket   credencial de 60 s emitida por el backend (obligatoria con ANPR_SERVICE_TOKEN)
          ancho    ancho máximo en px (320–1280, por omisión 640)
          fps      cuadros por segundo máximos (1–25, por omisión 10)
          calidad  calidad JPEG (30–90, por omisión 60)

        Solo se envía un cuadro nuevo cuando el pipeline produjo uno y dentro de la cadencia pedida.
        """
        if not ticket_valido(websocket.query_params.get("ticket"), "stream"):
            await websocket.close(code=4401)
            return
        ancho = _param_int(websocket, "ancho", 640, 320, 1280)
        intervalo = 1.0 / _param_int(websocket, "fps", 10, 1, 25)
        calidad = _param_int(websocket, "calidad", 60, 30, 90)

        await websocket.accept()
        buffer = motor.buffer_video
        buffer.add_viewer()
        logger.info("Visor de video conectado (%dpx, %.0f fps, q%d). Espectadores: %d", ancho, 1 / intervalo, calidad, buffer.viewers)
        ultimo = -1
        loop = asyncio.get_event_loop()
        try:
            while motor.activo:
                t0 = loop.time()
                jpeg, contador = await loop.run_in_executor(None, buffer.get_jpeg, ancho, calidad)
                if jpeg is None:
                    if ultimo != -2:
                        await websocket.send_bytes(_get_standby_jpeg())
                        ultimo = -2
                    await asyncio.sleep(1.0)
                    continue
                if contador != ultimo:
                    ultimo = contador
                    await websocket.send_bytes(jpeg)
                    await asyncio.sleep(max(0.005, intervalo - (loop.time() - t0)))
                else:
                    await asyncio.sleep(0.01)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.debug("Conexión WebSocket de video cerrada: %s", e)
        finally:
            buffer.remove_viewer()
            logger.info("Visor de video desconectado. Espectadores: %d", buffer.viewers)

    @app.websocket("/ws/pistas")
    @app.websocket("/api/ws/pistas")
    async def pistas(websocket: WebSocket):
        """
        Cajas de detección y zona de movimiento para dibujar sobre el video WebRTC del navegador:
        solo JSON (≈10 envíos por segundo); el video llega aparte desde MediaMTX. Se envía al
        cambiar y, mientras haya algo visible, al menos cada 0,3 s: el navegador desvanece las
        pistas que dejan de llegar.
        """
        if not ticket_valido(websocket.query_params.get("ticket"), "stream"):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        ultimo = None
        enviado = 0.0
        try:
            while motor.activo:
                datos = motor.pistas_actuales()
                ahora = time.monotonic()
                visible = bool(datos.get("pistas") or datos.get("movimiento"))
                if datos != ultimo or (visible and ahora - enviado >= 0.3):
                    await websocket.send_json(datos)
                    ultimo = datos
                    enviado = ahora
                await asyncio.sleep(0.1)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.debug("WebSocket de pistas cerrado: %s", e)

    @app.get("/debug/stream")
    def mjpeg_depuracion(request: Request):
        """Stream MJPEG anotado (diagnóstico; requiere X-Servicio-Token)."""
        if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
            return _denegado()
        return StreamingResponse(mjpeg_generator(motor.buffer_video, target_fps=30.0),
                                 media_type="multipart/x-mixed-replace; boundary=frame", headers=SIN_CACHE)

    @app.post("/api/camera/switch")
    async def cambiar_camara(request: Request):
        """Cambia en caliente la cámara RTSP del motor sin reiniciar el servicio."""
        if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
            return _denegado()
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        codigo, cuerpo = motor.cambiar_camara(payload)
        return cuerpo if codigo == 200 else JSONResponse(cuerpo, status_code=codigo)

    @app.post("/api/camera/roi")
    async def region_de_interes(request: Request):
        """
        Región de interés de la cámara activa (equivalente a la "detection mask" de OpenALPR):
        {"roi": [[x, y], ...]} normalizada 0–1, o {"roi": null} para el cuadro completo.
        """
        if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
            return _denegado()
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse({"error": "JSON inválido"}, status_code=400)
        codigo, cuerpo = motor.fijar_roi(payload)
        return cuerpo if codigo == 200 else JSONResponse(cuerpo, status_code=codigo)

    @app.get("/api/camera/active")
    def camara_activa():
        """Cámara y fuente activas en el motor."""
        return motor.camara_activa()

    @app.get("/status")
    def estado():
        """Estado y rendimiento del microservicio."""
        return motor.estado()

    @app.get("/metrics")
    def metricas():
        """Métricas Prometheus."""
        return Response(content=get_metrics(), media_type="text/plain")

    @app.get("/")
    def raiz():
        return {
            "service": "ECU 911 ANPR Microservice",
            "version": "2.0.0",
            "status": "running" if motor.activo else "starting",
            **motor.info_modelos(),
        }

    return app
