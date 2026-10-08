"""
Motor ANPR en tiempo real (capa de aplicación).

Concentra el estado que antes vivía en variables globales de main.py y lo protege con candados:

  1. Hilo productor: captura cuadros de la fuente a su tasa nativa y alimenta el video en vivo.
  2. Hilo consumidor: detección YOLO + seguimiento, OCR rápido asíncrono por track y selección del
     mejor cuadro de cada vehículo.
  3. Compuerta de captura (`disparar_captura`): segunda verificación OCR en alta fidelidad,
     validez de la lectura (verificacion_placa.py), anti-duplicados y registro en el backend en
     dos fases (/detecciones/ingreso y /detecciones/completar-ocr).

No conoce FastAPI ni crea adaptadores: todo lo externo (modelos, cámaras, cliente HTTP, disco,
métricas, registro) llega por `DependenciasMotor`, que arma la raíz de composición (app/main.py).
Así el motor se prueba con dobles (tests/test_motor_contrato.py) sin cargar modelos ni cámaras.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Optional

import cv2
import numpy as np

from app.aplicacion.detector import _ESTADOS_FINALES, compute_crop_sharpness
from app.aplicacion.verificacion_placa import (
    MIN_CARACTERES,
    analizar_caracteres,
    cuadrilatero_placa,
    evaluar_lectura,
    recorte_con_margen,
    toca_borde_lateral,
)
from app.dominio.credenciales import sin_credenciales
from app.dominio.ecuador_plate_validator import validate_ecuadorian_plate
from app.dominio.memoria import purgar_expirados

# Ventana en la que un mismo vehículo (track o placa) no se registra dos veces
PLATE_DEBOUNCE_SECONDS = 35.0
# Enfriamiento entre lecturas OCR rápidas de un mismo track (RTSP y navegador). El OCR rápido
# cuesta ~25 ms: con 0,25 s el consenso de 2–3 lecturas se forma en menos de medio segundo.
ENFRIAMIENTO_OCR_S = 0.25
ENFRIAMIENTO_OCR_NAVEGADOR_S = 0.25
# Capturas de un mismo track: si la foto elegida resulta ilegible, el selector elige otro cuadro
# del mismo paso en lugar de perder el vehículo (hasta este número de intentos)
MAX_INTENTOS_CAPTURA = 3


def _medido(funcion: Callable, *args, **kwargs) -> tuple[Any, float]:
    """Resultado de la función y su duración en milisegundos."""
    t0 = time.perf_counter()
    resultado = funcion(*args, **kwargs)
    return resultado, (time.perf_counter() - t0) * 1000.0


@dataclass(frozen=True)
class ConfigMotor:
    backend_url: str
    camara_id: int
    fuente_camara: str
    rtsp_url: str
    indice_webcam: int
    dir_media: str
    #: Dibujar el HUD sobre el video (DEBUG_VISUAL)
    hud_activo: bool
    #: Ventana local de OpenCV (DEBUG_SHOW_WINDOW fuera de Docker)
    ventana_local: bool
    #: Peso del voto del verificador PP-OCRv6 frente a una lectura rápida
    peso_voto_verificador: float
    # Registro del paso (docs/METODO_VERIFICACION_LECTURA.md §2.5). Los valores por omisión son los
    # de producción; scripts/evaluar_latencia.py los cambia para la ablación pareada.
    #: OCR profundo, verificador y vehículo en paralelo (False: uno tras otro)
    registro_paralelo: bool = True
    #: Análisis del vehículo iniciado al aparecer la placa completa (False: al registrar)
    vehiculo_anticipado: bool = True
    #: Fotos de un mismo track que se prueban antes de descartarlo (1: sin reintento)
    intentos_captura: int = MAX_INTENTOS_CAPTURA
    #: Enfriamiento entre lecturas OCR rápidas de un track RTSP
    enfriamiento_ocr_s: float = ENFRIAMIENTO_OCR_S


@dataclass
class DependenciasMotor:
    """Puertos del motor: los implementa la infraestructura y los conecta app/main.py."""

    crear_fuente_video: Callable[[], Any]
    crear_pipeline: Callable[[], Any]
    crear_selector: Callable[[], Any]
    crear_motor_ocr: Callable[[], Any]
    crear_trabajador_ocr: Callable[[Any, Callable[..., Any]], Any]
    #: Verificador PP-OCRv6 (o None si no está disponible)
    verificador: Callable[[], Any]
    #: Reconocedor de atributos del vehículo (o None)
    reconocedor_vehiculo: Callable[[], Any]
    fuente_rtsp: Callable[[str], Any]
    fuente_webcam: Callable[[int], Any]
    cuadro_espera: Callable[[str], np.ndarray]
    mostrar_ventana: Callable[[str, np.ndarray], bool]
    cerrar_ventanas: Callable[[], None]
    guardar_imagen: Callable[[str, np.ndarray], Any]
    #: Métricas Prometheus (update_fps, record_detection…)
    metricas: Any
    logger: Any


def nitidez_recorte(frame: np.ndarray, plate_bbox: list[int]) -> Optional[float]:
    """Nitidez (varianza del Laplaciano) del recorte de placa, en la misma escala que el filtro del tracker."""
    try:
        x1, y1, x2, y2 = [int(v) for v in plate_bbox]
        h, w = frame.shape[:2]
        return compute_crop_sharpness(frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)])
    except Exception:
        return None


def leible(plate_bbox: list[int], frame: np.ndarray, ancho_min: int, alto_min: int) -> bool:
    """
    La placa tiene tamaño suficiente para el OCR y no está cortada por el borde izquierdo o
    derecho del cuadro. Una placa que entra por un lado se lee truncada ("SY589" en vez de
    "PSY589") y, si el texto truncado tiene formato ANT, votaría por una placa equivocada en el
    consenso del track. (La validez de la lectura exige además que no toque ningún borde, E2.)
    """
    x1, y1, x2, y2 = plate_bbox
    return (x2 - x1) >= ancho_min and (y2 - y1) >= alto_min and not toca_borde_lateral(plate_bbox, frame.shape[1])


def recorte_con_holgura(frame: np.ndarray, plate_bbox: list[int], pad_x: float = 0.10, pad_y: float = 0.15) -> np.ndarray:
    """Recorte de la placa con margen, para que el OCR no pierda caracteres en los bordes."""
    x1, y1, x2, y2 = [int(v) for v in plate_bbox]
    h, w = frame.shape[:2]
    px, py = int((x2 - x1) * pad_x), int((y2 - y1) * pad_y)
    crop = frame[max(0, y1 - py):min(h, y2 + py), max(0, x1 - px):min(w, x2 + px)]
    return crop if crop.size else frame


class MotorAnpr:
    """Estado y comportamiento del motor de reconocimiento en tiempo real."""

    def __init__(self, config: ConfigMotor, dep: DependenciasMotor, http: Any, buffer_video: Any) -> None:
        self._config = config
        self._dep = dep
        self._http = http
        self._log = dep.logger
        self._m = dep.metricas
        self.buffer_video = buffer_video
        self._dir_media = config.dir_media

        # Cámara activa (la cambia el backend en caliente)
        self.camara_id: int = config.camara_id
        self.fuente_camara: str = config.fuente_camara

        # Componentes que se crean al iniciar
        self._fuente: Any = None
        self._pipeline: Any = None
        self._selector: Any = None
        self._trabajador_ocr: Any = None
        self._hilo_captura: Optional[threading.Thread] = None
        self._activo = False
        self._fps_captura = 0.0
        #: Tamaño del último cuadro de la fuente (las cajas del pipeline están en esas coordenadas)
        self.tamano_fuente: dict[str, int] = {"w": 0, "h": 0}

        self._ejecutor_disco = ThreadPoolExecutor(max_workers=2, thread_name_prefix="DiskIO")
        self._ejecutor_ocr = ThreadPoolExecutor(max_workers=2, thread_name_prefix="AsyncOCR")
        #: Etapas del registro que se ejecutan en paralelo (OCR profundo, verificador, vehículo)
        self._ejecutor_etapas = ThreadPoolExecutor(max_workers=3, thread_name_prefix="Registro")
        #: Detección YOLO de cuadros del navegador (aislada del OCR y del disco)
        self.ejecutor_navegador = ThreadPoolExecutor(max_workers=2, thread_name_prefix="BrowserYOLO")

        # Registros en memoria protegidos por un mismo candado
        self._candado = threading.Lock()
        self._ocr_en_curso: set[int] = set()
        self._ultimo_intento_ocr: dict[int, float] = {}
        self._capturas_por_track: dict[int, float] = {}
        self._placas_registradas: dict[str, float] = {}
        #: Capturas fallidas por track: (intentos, hora del último)
        self._intentos_captura: dict[int, tuple[int, float]] = {}
        #: Análisis del vehículo iniciado por adelantado para cada track en movimiento: (futuro, hora)
        self._vehiculos: dict[int, tuple[Future, float]] = {}

        # Cuadro compartido entre el productor y el consumidor
        self._candado_cuadro = threading.Lock()
        self._cuadro_compartido: Optional[np.ndarray] = None
        self._indice_cuadro = 0
        self._cuadro_nuevo = threading.Event()

        self._candado_cambio_camara = threading.Lock()
        #: Un solo cuadro del navegador a la vez (los demás se descartan para no acumular latencia)
        self.candado_navegador = threading.Lock()

    # ─── Consultas ──────────────────────────────────────────────────────────

    @property
    def activo(self) -> bool:
        return self._activo

    @property
    def fps_captura(self) -> float:
        return self._fps_captura

    @property
    def pipeline(self) -> Any:
        return self._pipeline

    def info_modelos(self) -> dict:
        """Modelos realmente cargados (detector, OCR principal y verificador)."""
        ocr = getattr(getattr(self._trabajador_ocr, "_agent", None), "_ocr", None)
        verificador = self._dep.verificador() if self._activo else None
        detector = getattr(self._pipeline, "detector", None)
        return {
            "detector": os.path.basename(getattr(detector, "model_path", "") or "") or None,
            "detector_arquitectura": getattr(detector, "arquitectura", None),
            "ocr_engine": f"{getattr(ocr, 'engine_name', '?')} ({getattr(ocr, 'model_id', '?')})" if ocr else None,
            "ocr_verifier": verificador.description if verificador else None,
        }

    def estado(self) -> dict:
        return {
            "status": "online",
            "running": self._activo,
            "camera_source": sin_credenciales(self.fuente_camara),
            "capture_fps": round(self._fps_captura, 1),
            "tracker_fps": round(self._pipeline.fps if self._pipeline else 0.0, 1),
            # Cuadros en que la compuerta de movimiento omitió el detector (escena quieta)
            "inferencias_omitidas_pct": round(100 * self._pipeline.proporcion_omitida("rtsp"), 1) if self._pipeline else None,
            **self.info_modelos(),
            "architecture": "Two-Phase: Fast Capture + Async OCR",
        }

    def camara_activa(self) -> dict:
        conectada = self._fuente.is_connected if self._fuente else False
        if not conectada and self._fps_captura >= 10.0:
            conectada = True
        return {
            "camera_id": self.camara_id,
            "camera_source": sin_credenciales(self.fuente_camara),
            "is_connected": conectada,
            "roi": self._pipeline.roi if self._pipeline else None,
        }

    def pistas_actuales(self) -> dict:
        """Cajas de detección vigentes y zona de movimiento, normalizadas a 0–1 respecto del
        cuadro de la fuente (velocidades en fracción del cuadro por segundo)."""
        w, h = self.tamano_fuente["w"], self.tamano_fuente["h"]
        pipeline = self._pipeline
        if not pipeline or not w or not h:
            return {"pistas": [], "roi": pipeline.roi if pipeline else None, "movimiento": None}
        ahora = time.time()
        with pipeline._overlays_lock:
            cajas = [ov for ov in pipeline._current_overlays if ahora - ov.timestamp < 1.0]

        def n(x: float, total: int) -> float:
            return round(max(0.0, min(1.0, x / total)), 4)

        pistas = []
        for ov in cajas:
            pistas.append({
                "id": ov.tracking_id,
                "caja": [n(ov.x1, w), n(ov.y1, h), n(ov.x2, w), n(ov.y2, h)],
                "puntos": [[n(px, w), n(py, h)] for px, py in ov.oriented_box] if ov.oriented_box and len(ov.oriented_box) == 4 else None,
                "velocidad": [round(ov.velocidad[0] / w, 4), round(ov.velocidad[1] / h, 4)],
                "confianza": round(ov.confianza, 3),
                "placa": ov.placa or None,
                "parcial": ov.parcial or None,
                "confianza_placa": round(ov.confianza_placa, 3),
                "estado": ov.estado or None,
                "verificada": ov.verificada,
            })
        caja, porcentaje, vehiculo = pipeline.get_motion_info()
        movimiento = None
        if caja and vehiculo and porcentaje > 3:
            movimiento = {"caja": [n(caja[0], w), n(caja[1], h), n(caja[2], w), n(caja[3], h)], "porcentaje": porcentaje}
        return {"pistas": pistas, "roi": pipeline.roi, "movimiento": movimiento}

    # ─── Ciclo de vida ──────────────────────────────────────────────────────

    def iniciar(self) -> None:
        self._log.info("=" * 60)
        self._log.info("  ECU 911 ANPR Microservice — Motor Cero Latencia en Tiempo Real")
        self._log.info("  Captura Sincronizada + PaddleOCR Asíncrono de Alta Fidelidad")
        self._log.info("=" * 60)

        self._fuente = self._dep.crear_fuente_video()
        self._pipeline = self._dep.crear_pipeline()
        self._selector = self._dep.crear_selector()
        self._trabajador_ocr = self._dep.crear_trabajador_ocr(self._dep.crear_motor_ocr(), self._pipeline.update_track_plate)
        self._trabajador_ocr.start()
        # Precarga del verificador PP-OCRv6 (la compilación OpenVINO tarda unos segundos) y del reconocedor
        threading.Thread(target=self._dep.verificador, daemon=True, name="OcrVerifierInit").start()
        threading.Thread(target=self._dep.reconocedor_vehiculo, daemon=True, name="VehicleAttrInit").start()

        self._activo = True
        self._hilo_captura = threading.Thread(
            target=self._bucle_tiempo_real,
            args=(self._fuente, self._pipeline, self._selector),
            daemon=True,
            name="anpr-realtime-engine",
        )
        self._hilo_captura.start()

    def detener(self) -> None:
        self._log.info("Cerrando servicio ANPR...")
        self._activo = False
        if self._trabajador_ocr:
            self._trabajador_ocr.stop()
        if self._hilo_captura and self._hilo_captura.is_alive():
            self._hilo_captura.join(timeout=2.0)
        self._ejecutor_disco.shutdown(wait=False)
        self._ejecutor_ocr.shutdown(wait=False)
        self._ejecutor_etapas.shutdown(wait=False)
        self.ejecutor_navegador.shutdown(wait=False)
        self._http.close()
        self._log.info("Servicio ANPR cerrado limpiamente.")

    # ─── OCR rápido asíncrono ───────────────────────────────────────────────

    def encolar_ocr(self, tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int]) -> None:
        """OCR rápido de un track en un pool aparte, con enfriamiento: el seguimiento y el video
        nunca esperan al OCR."""
        self._encolar(tracking_id, tracking_id, frame_copy, plate_bbox, self._config.enfriamiento_ocr_s, navegador=False)

    def encolar_ocr_navegador(self, tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int]) -> None:
        """OCR del flujo WebSocket del navegador. Escribe en el espacio de tracks del navegador para
        que una lectura RTSP previa no aparezca sobre una caja del navegador en otra posición; las
        claves negativas evitan colisiones con los tracks RTSP. Re-escanea cada 0,5 s para refinar
        el consenso conforme el auto avanza."""
        self._encolar(-(tracking_id + 1), tracking_id, frame_copy, plate_bbox, ENFRIAMIENTO_OCR_NAVEGADOR_S, navegador=True)

    def _encolar(self, clave: int, tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int],
                 enfriamiento: float, navegador: bool) -> None:
        ahora = time.time()
        with self._candado:
            if clave in self._ocr_en_curso:
                return
            if ahora - self._ultimo_intento_ocr.get(clave, 0.0) < enfriamiento:
                return
            self._ocr_en_curso.add(clave)
            self._ultimo_intento_ocr[clave] = ahora

        def _trabajo():
            try:
                trabajador = self._trabajador_ocr
                pipeline = self._pipeline
                if trabajador and getattr(trabajador, "_agent", None) and pipeline:
                    res = trabajador._agent.process_image(frame_copy, plate_bbox, fast_mode=True)
                    if res.placa:
                        estado = "leida" if res.estado == "procesado" else "escaneando"
                        votar = pipeline.update_browser_track_plate if navegador else pipeline.update_track_plate
                        votar(tracking_id, res.placa, res.confianza, estado, quality=nitidez_recorte(frame_copy, plate_bbox))
            except Exception as e:
                self._log.warning("Aviso en OCR %sasíncrono para track #%d: %s", "browser " if navegador else "", tracking_id, e)
                self._m.record_ocr_error("ocr_asincrono")
            finally:
                with self._candado:
                    self._ocr_en_curso.discard(clave)

        self._ejecutor_ocr.submit(_trabajo)

    # ─── Hilos de captura y detección ───────────────────────────────────────

    def _hilo_deteccion(self, pipeline: Any, selector: Any) -> None:
        """Consumidor: detección YOLO y seguimiento, desacoplado de la captura y del video."""
        ultimo_procesado = -1
        self._log.info("Hilo de inferencia y tracking desacoplado iniciado.")

        while self._activo:
            senal = self._cuadro_nuevo.wait(timeout=0.03)
            if not self._activo:
                break
            if not senal:
                continue
            self._cuadro_nuevo.clear()

            with self._candado_cuadro:
                if self._cuadro_compartido is None or self._indice_cuadro == ultimo_procesado:
                    continue
                frame = self._cuadro_compartido.copy()
                idx = self._indice_cuadro
                ultimo_procesado = idx

            try:
                # 1. Detección y seguimiento (actualiza los overlays del pipeline @ 512 px)
                rois = pipeline.detect_and_track(frame, imgsz=512)
                activos = {roi.tracking_id for roi in rois}
                self._m.update_tracking_active(len(activos))
                self._m.record_inference("rtsp", pipeline.inferencia_omitida("rtsp"))

                # 2. OCR asíncrono de cada track hasta reunir 3 lecturas concordantes: son la
                #    evidencia de consenso multi-cuadro que exige la validez de la lectura.
                for roi in rois:
                    info = pipeline.get_track_info(roi.tracking_id)
                    if (info.get("lecturas", 0) < 3 and info.get("status") not in _ESTADOS_FINALES
                            and leible(roi.plate_bbox, frame, ancho_min=16, alto_min=6)):
                        self.encolar_ocr(roi.tracking_id, frame.copy(), roi.plate_bbox)
                    self._anticipar_vehiculo(roi, frame)

                # 3. Calidad del cuadro y disparo de la captura fotográfica
                self._evaluar_capturas(selector, rois, frame, idx)
            except Exception as e:
                self._log.error("Error en hilo de detección desacoplado: %s", e)
                self._m.record_detection_error("deteccion")

    def _anticipar_vehiculo(self, roi: Any, frame: np.ndarray) -> None:
        """
        Inicia el análisis del vehículo (tipo, color, marca) en cuanto un track en movimiento tiene
        la placa completa dentro del cuadro, en paralelo con la espera del mejor cuadro de la placa:
        el resultado no depende de esa foto y así no alarga el registro (era su etapa más lenta).
        """
        tid = roi.tracking_id
        if not self._config.vehiculo_anticipado or not getattr(roi, "en_movimiento", False) or tid in self._vehiculos:
            return
        if not leible(roi.plate_bbox, frame, ancho_min=30, alto_min=10):
            return
        alto, ancho = frame.shape[:2]
        x1, y1, x2, y2 = roi.plate_bbox
        if y1 <= 2 or y2 >= alto - 2:
            return
        reconocedor = self._dep.reconocedor_vehiculo()
        if reconocedor is None:
            return
        caja = [int(v) for v in roi.plate_bbox]
        with self._candado:
            if tid in self._vehiculos:
                return
            self._vehiculos[tid] = (self._ejecutor_etapas.submit(_medido, reconocedor.analyze, frame.copy(), caja), time.time())

    def _evaluar_capturas(self, selector: Any, rois: list, frame: np.ndarray, idx: int) -> None:
        """Mejor cuadro de cada track y tracks que salieron de cuadro → compuerta de captura."""
        for roi in rois:
            elegido = selector.evaluate_and_select(
                tracking_id=roi.tracking_id, frame=frame, plate_bbox=roi.plate_bbox,
                confidence=roi.confidence, frame_idx=idx,
            )
            if elegido is not None:
                self.disparar_captura(elegido)
        for salido in selector.cleanup_stale_tracks({roi.tracking_id for roi in rois}):
            self.disparar_captura(salido)

    def _bucle_tiempo_real(self, fuente_inicial: Any, pipeline: Any, selector: Any) -> None:
        """Productor: captura a la tasa de la fuente, entrega cada cuadro al consumidor y mantiene
        el video en vivo (HUD solo si hay espectadores)."""
        self._log.info("Motor ANPR en Tiempo Real (Streaming Continuo 30+ FPS) iniciado.")

        # Conexión inicial sin bloquear el arranque si la cámara está apagada
        if fuente_inicial.connect():
            self._log.info("Fuente de video conectada exitosamente.")
        else:
            self._log.info("Cámara física actualmente apagada o en espera. Iniciando en modo Standby...")

        threading.Thread(target=self._hilo_deteccion, args=(pipeline, selector), daemon=True, name="ANPR-Detection-Worker").start()

        cuadros = 0
        inicio_fps = time.time()
        ventana = self._config.ventana_local
        fallos_seguidos = 0
        os.makedirs(self._dir_media, exist_ok=True)

        while self._activo:
            fuente = self._fuente or fuente_inicial
            if fuente is None:
                time.sleep(0.04)
                continue

            ok, frame = fuente.read_frame()
            if not ok or frame is None:
                fallos_seguidos += 1
                if fallos_seguidos >= 40 and fallos_seguidos % 30 == 0:
                    self.buffer_video.update(self._dep.cuadro_espera(getattr(fuente, "_name", "Canal Activo")))
                time.sleep(0.02)
                continue

            fallos_seguidos = 0
            cuadros += 1
            self.tamano_fuente["h"], self.tamano_fuente["w"] = frame.shape[:2]

            with self._candado_cuadro:
                self._cuadro_compartido = frame
                self._indice_cuadro = cuadros
            self._cuadro_nuevo.set()

            # FPS con media móvil cada 10 cuadros
            if cuadros % 10 == 0:
                transcurrido = time.time() - inicio_fps
                if transcurrido > 0:
                    instantaneo = 10.0 / transcurrido
                    self._fps_captura = round(0.7 * self._fps_captura + 0.3 * instantaneo if self._fps_captura > 0 else instantaneo, 1)
                    self._m.update_fps(self._fps_captura, str(self.camara_id))
                inicio_fps = time.time()

            # HUD y buffer de video solo si alguien lo mira (ahorra CPU sin espectadores)
            if self._config.hud_activo and (ventana or self.buffer_video.viewers > 0):
                anotado = pipeline.draw_overlays(frame.copy(), capture_fps=self._fps_captura, inference_fps=pipeline.fps)
                self.buffer_video.update(anotado)
                if ventana and not self._dep.mostrar_ventana("ANPR ECU 911 - Stream en Vivo (Scout)", anotado):
                    ventana = False

        fuente_inicial.release()
        if ventana:
            try:
                self._dep.cerrar_ventanas()
            except Exception:
                pass
        self._log.info("Motor ANPR en Tiempo Real finalizado.")

    # ─── Cuadros del navegador ──────────────────────────────────────────────

    def procesar_cuadro_ws(self, frame: np.ndarray, rois: list) -> dict:
        """Respuesta del WebSocket de la webcam para las detecciones de un cuadro (OCR por el
        espacio de tracks del navegador y captura automática)."""
        pipeline = self._pipeline
        ahora = time.time()
        self._m.record_inference("navegador", pipeline.inferencia_omitida("navegador"))
        datos = []
        for r in rois:
            info = pipeline.get_browser_track_info(r.tracking_id)
            if leible(r.plate_bbox, frame, ancho_min=16, alto_min=6):
                self.encolar_ocr_navegador(r.tracking_id, frame.copy(), r.plate_bbox)
            lecturas = int(info.get("lecturas", 0))
            datos.append({
                "tracking_id": r.tracking_id,
                "confidence": round(r.confidence, 3),
                "bbox": r.plate_bbox,
                "oriented_box": getattr(r, "oriented_box", []),
                "velocity": r.velocity,
                "ts": round(ahora, 4),
                "plate": info.get("plate", ""),
                "status": info.get("status", ""),
                "plate_confidence": round(info.get("confidence", 0.0), 3),
                "lecturas": lecturas,
                "en_movimiento": r.en_movimiento,
                # Mismo criterio que el video RTSP: placa en movimiento o con una lectura ANT
                "mostrar": r.en_movimiento or lecturas >= 1,
            })
        if self._selector and self._trabajador_ocr:
            self._evaluar_capturas(self._selector, rois, frame, int(ahora * 30))
        caja, porcentaje, vehiculo = pipeline.get_motion_info("navegador")
        return {"rois": datos, "motion_bbox": caja, "motion_pct": porcentaje, "motion_vehicle_detected": vehiculo}

    def procesar_cuadro_http(self, frame: np.ndarray, rois: list) -> dict:
        """Respuesta de POST /process/frame para las detecciones de un cuadro del navegador."""
        pipeline = self._pipeline
        for roi in rois:
            info = pipeline.get_track_info(roi.tracking_id) if pipeline else {}
            if not info.get("plate") and leible(roi.plate_bbox, frame, ancho_min=20, alto_min=8):
                self.encolar_ocr(roi.tracking_id, frame.copy(), roi.plate_bbox)
        if self._selector and self._trabajador_ocr:
            self._evaluar_capturas(self._selector, rois, frame, int(time.time() * 30))

        caja, porcentaje, vehiculo = pipeline.get_motion_info("navegador") if pipeline else (None, 0, False)
        datos = []
        for r in rois:
            info = pipeline.get_browser_track_info(r.tracking_id) if pipeline else {}
            datos.append({
                "tracking_id": r.tracking_id,
                "confidence": round(r.confidence, 3),
                "bbox": r.plate_bbox,
                "oriented_box": getattr(r, "oriented_box", []),
                "velocity": getattr(r, "velocity", [0.0, 0.0]),
                "plate": info.get("plate", ""),
                "status": info.get("status", ""),
                "plate_confidence": round(info.get("confidence", 0.0), 3),
                "lecturas": int(info.get("lecturas", 0)),
            })
        # Video de diagnóstico en segundo plano (no retrasa la respuesta)
        if pipeline:
            self._ejecutor_disco.submit(
                lambda f: self.buffer_video.update(pipeline.draw_overlays(f, capture_fps=30.0, inference_fps=pipeline.fps)),
                frame.copy(),
            )
        return {"success": True, "rois": datos, "motion_bbox": caja, "motion_pct": porcentaje, "motion_vehicle_detected": vehiculo}

    # ─── Cámara y región de interés ─────────────────────────────────────────

    def cambiar_camara(self, payload: dict) -> tuple[int, dict]:
        """Cambia en caliente la fuente de video (RTSP o webcam) sin reiniciar el servicio.
        Devuelve (código HTTP, cuerpo)."""
        camera_id = int(payload.get("camera_id", 1))
        tipo = str(payload.get("source_type", "rtsp")).lower().strip()
        rtsp_url = payload.get("rtsp_url")
        nombre = payload.get("nombre", "Cámara Activa")
        forzar = bool(payload.get("force", False))
        # Región de interés de la cámara (ausente = sin cambio)
        if "roi" in payload and self._pipeline:
            self._pipeline.set_roi(payload.get("roi"))

        self._log.info("Solicitud de cambio de cámara activa ANPR: ID %d | %s | %s | force=%s", camera_id, tipo, sin_credenciales(rtsp_url) or "", forzar)

        with self._candado_cambio_camara:
            anterior = self._fuente
            fuente_txt = "webcam" if tipo == "webcam" else (rtsp_url or self._config.rtsp_url)

            # No reiniciar si la cámara pedida ya está activa y conectada, salvo que se fuerce
            en_marcha = anterior and getattr(anterior, "_grab_running", False) and getattr(anterior, "is_connected", False)
            if not forzar and en_marcha and getattr(anterior, "_url", None) == fuente_txt and self.camara_id == camera_id:
                self._log.info("Cámara ID %d (%s) ya activa y conectada.", camera_id, sin_credenciales(fuente_txt))
                return 200, {
                    "success": True,
                    "message": f"Cámara ID {camera_id} ya se encuentra activa",
                    "camera_id": self.camara_id,
                    "camera_source": sin_credenciales(self.fuente_camara),
                }

            try:
                nueva = self._dep.fuente_webcam(self._config.indice_webcam) if tipo == "webcam" else self._dep.fuente_rtsp(fuente_txt)
                nueva._name = nombre
                nueva._url = fuente_txt

                # Pantalla de transición inmediata: no se congela ni se muestra el canal anterior
                self.buffer_video.update(self._dep.cuadro_espera(nombre))

                self._fuente = nueva
                self.camara_id = camera_id
                self.fuente_camara = fuente_txt
                threading.Thread(target=nueva.connect, daemon=True, name="CamConnect").start()

                # Tracks, consensos y candidatos pertenecen al canal anterior
                if self._pipeline:
                    self._pipeline.clear_all_tracks()
                if self._selector:
                    for registro in ("_active_candidates", "_captured_history", "_prev_area", "_track_first_seen"):
                        getattr(self._selector, registro).clear()

                if anterior:
                    threading.Thread(target=anterior.release, daemon=True, name="CamRelease").start()

                return 200, {
                    "success": True,
                    "message": f"Cámara cambiada exitosamente a ID {camera_id} ({nombre})",
                    "camera_id": self.camara_id,
                    "camera_source": sin_credenciales(self.fuente_camara),
                }
            except Exception as e:
                self._log.error("Error al cambiar fuente de video: %s", e)
                return 500, {"error": f"Error al cambiar cámara: {str(e)}"}

    def fijar_roi(self, payload: dict) -> tuple[int, dict]:
        """Región de interés de la cámara activa ({"roi": [[x, y], …]} normalizada 0–1 o null)."""
        if not self._pipeline:
            return 503, {"error": "Motor no iniciado"}
        camara = payload.get("camara_id")
        if camara is not None and int(camara) != self.camara_id:
            # Pertenece a otra cámara: se aplicará cuando esa cámara se active
            return 200, {"success": True, "aplicada": False, "roi": self._pipeline.roi}
        return 200, {"success": True, "aplicada": True, "roi": self._pipeline.set_roi(payload.get("roi"))}

    # ─── Compuerta de captura ───────────────────────────────────────────────

    def disparar_captura(self, candidato: Any) -> None:
        """
        Compuerta de cero falsos positivos: nunca se guarda una imagen ni se crea un ingreso a menos
        que la región contenga una matrícula comprobada (autos o motos). El trabajo pesado (OCR en
        alta fidelidad, disco y red) corre en segundo plano.
        """
        tracking_id = getattr(candidato, "tracking_id", -1)
        ahora = time.time()
        with self._candado:
            if tracking_id in self._capturas_por_track and (ahora - self._capturas_por_track[tracking_id] < PLATE_DEBOUNCE_SECONDS):
                return
            self._capturas_por_track[tracking_id] = ahora

        frame = candidato.frame.copy() if candidato.frame is not None else None
        if frame is None or frame.size == 0:
            return
        self._ejecutor_disco.submit(self._verificar_y_registrar, candidato, tracking_id, frame, ahora)

    def _ya_registrada(self, placa: str, ahora: float) -> Optional[float]:
        """Segundos desde que la placa se registró, si fue dentro de la ventana anti-duplicados."""
        registrada = self._placas_registradas.get(placa)
        return ahora - registrada if registrada is not None and ahora - registrada < PLATE_DEBOUNCE_SECONDS else None

    def _descartar(self, tracking_id: int, motivo: str, texto: Optional[str], confianza: float) -> None:
        """Auditoría del descarte en el backend (un falso positivo no contamina la base)."""
        self._m.record_detection("descartada", str(self.camara_id))
        try:
            self._http.post(
                f"{self._config.backend_url}/api/detecciones/descarte",
                json={
                    "tracking_id": tracking_id,
                    "motivo": motivo,
                    "texto_candidato": texto,
                    "confianza": round(confianza, 3),
                    "fuente": self.fuente_camara,
                    "camara_id": self.camara_id,
                },
                timeout=2.0,
            )
        except Exception:
            pass

    def _liberar_para_reintento(self, tracking_id: int) -> bool:
        """
        La foto elegida no permitió leer la placa: el track queda libre para que el selector elija
        otro cuadro del mismo paso (más nítido o más cerca), hasta `intentos_captura`. Antes,
        una sola foto ilegible hacía perder el vehículo completo. True si queda otro intento.
        """
        ahora = time.time()
        with self._candado:
            intentos = self._intentos_captura.get(tracking_id, (0, ahora))[0] + 1
            self._intentos_captura[tracking_id] = (intentos, ahora)
            if intentos >= self._config.intentos_captura:
                return False
            self._capturas_por_track.pop(tracking_id, None)
        if self._selector is not None:
            self._selector.liberar(tracking_id)
        return True

    def _verificar_y_registrar(self, candidato: Any, tracking_id: int, frame: np.ndarray, ahora: float) -> None:
        etapas: dict[str, Any] = {}
        propio: Optional[Future] = None  # análisis del vehículo lanzado por este intento
        try:
            pipeline = self._pipeline
            trabajador = self._trabajador_ocr
            # 1. Lecturas previas en ambos espacios de tracks (RTSP y navegador)
            info_navegador = pipeline.get_browser_track_info(tracking_id) if pipeline else {}
            info_rtsp = pipeline.get_track_info(tracking_id) if pipeline else {}
            placa_previa = info_navegador.get("plate") or info_rtsp.get("plate", "")
            conf_previa = max(info_navegador.get("confidence", 0.0), info_rtsp.get("confidence", 0.0))

            # Anti-duplicado temprano, antes del OCR profundo y del disco
            if placa_previa:
                limpia_previa = placa_previa.replace("-", "").strip().upper()
                with self._candado:
                    hace = self._ya_registrada(limpia_previa, time.time())
                if hace is not None:
                    self._log.info(
                        "[ANTI-DUPLICADO PRELIMINAR] Track #%d placa preliminar '%s' ya registrada hace %.1fs. Omitiendo captura.",
                        tracking_id, limpia_previa, hace,
                    )
                    return

            # Lecturas de OTROS cuadros del track, antes de sumar las de este (para no contar dos
            # veces el mismo cuadro con el OCR profundo y el verificador)
            conteo_previo = pipeline.conteo_lecturas(tracking_id) if pipeline else {}

            # 2. OCR profundo (homografía + binarización adaptativa), segundo OCR (PP-OCRv6) y
            #    atributos del vehículo EN PARALELO: los tres parten de la misma foto y, uno tras
            #    otro, eran la mayor parte de la latencia del registro.
            agente = getattr(trabajador, "_agent", None) if trabajador else None
            verificador = self._dep.verificador()
            reconocedor = self._dep.reconocedor_vehiculo()
            caja_placa = [int(v) for v in candidato.plate_bbox]

            def lanzar(funcion: Callable, *args, **kwargs) -> Future:
                futuro = self._ejecutor_etapas.submit(_medido, funcion, *args, **kwargs)
                if not self._config.registro_paralelo:
                    futuro.exception()  # ablación: cada etapa espera a que termine la anterior
                return futuro

            if agente:
                etapas["ocr_profundo"] = lanzar(agente.process_image, frame, initial_bbox=candidato.plate_bbox, fast_mode=False)
            if verificador is not None:
                etapas["verificador"] = lanzar(verificador.read, recorte_con_holgura(frame, candidato.plate_bbox))
            with self._candado:
                anticipado = self._vehiculos.get(tracking_id)
            if anticipado is not None and not anticipado[0].cancelled():
                etapas["vehiculo"] = anticipado[0]  # iniciado al aparecer el vehículo
            elif reconocedor is not None and len(caja_placa) == 4:
                etapas["vehiculo"] = lanzar(reconocedor.analyze, frame, caja_placa)
                propio = etapas["vehiculo"]

            placa, conf = "", 0.0
            profundo = None
            if "ocr_profundo" in etapas:
                profundo, _ = etapas["ocr_profundo"].result()
                if profundo.placa and profundo.estado == "procesado":
                    placa, conf = profundo.placa, profundo.confianza
                elif profundo.placa and len(profundo.placa.replace("-", "").strip()) >= 4:
                    es_valida, formateada, puntaje = validate_ecuadorian_plate(profundo.placa)
                    if es_valida:
                        placa, conf = formateada, max(profundo.confianza, puntaje)

            # 2.1 Segunda lectura con PP-OCRv6 sobre la mejor foto: más precisa pero demasiado lenta
            #     para cada cuadro, así que solo una vez por vehículo
            placa_verificador, conf_verificador = "", 0.0
            if "verificador" in etapas:
                ver, _ = etapas["verificador"].result()
                if ver.plate and ver.within_budget:
                    es_valida, formateada, _ = validate_ecuadorian_plate(ver.plate)
                    if es_valida:
                        placa_verificador, conf_verificador = formateada, ver.confidence
                self._log.info(
                    "[VERIFICADOR %s] Track #%d | lectura '%s' (%.2f) en %.0f ms%s",
                    verificador.description, tracking_id, ver.plate or "-", ver.confidence, ver.elapsed_ms,
                    "" if ver.within_budget else " — descartada por exceder el presupuesto",
                )

            # Consenso temporal: la lectura profunda suma un voto al consenso del track (lecturas de
            # varios cuadros) en lugar de reemplazarlo: un único cuadro mal leído no decide la placa.
            if pipeline and (placa or placa_verificador):
                usa_navegador = bool(info_navegador)
                votar = pipeline.update_browser_track_plate if usa_navegador else pipeline.update_track_plate
                consultar = pipeline.get_browser_track_info if usa_navegador else pipeline.get_track_info
                nitidez = nitidez_recorte(frame, candidato.plate_bbox)
                if placa:
                    votar(tracking_id, placa, conf, "", quality=nitidez)
                if placa_verificador:
                    # El verificador pesa más que una lectura rápida
                    votar(tracking_id, placa_verificador, conf_verificador * self._config.peso_voto_verificador, "", quality=nitidez)
                consenso = consultar(tracking_id)
                placa_consenso = consenso.get("plate", "")
                if placa and placa_consenso and placa_consenso != placa.replace("-", "").upper():
                    es_valida, formateada, _ = validate_ecuadorian_plate(placa_consenso)
                    if es_valida:
                        self._log.info(
                            "[CONSENSO] Track #%d | lectura del frame '%s' reemplazada por consenso multi-frame '%s'",
                            tracking_id, placa, formateada,
                        )
                        placa = formateada
                        conf = float(consenso.get("confidence", conf))

            # Sin certeza del OCR profundo: lectura preliminar si tiene formato ANT
            if not placa and placa_previa:
                es_valida, formateada, puntaje = validate_ecuadorian_plate(placa_previa)
                if es_valida:
                    placa, conf = formateada, max(conf_previa, puntaje)

            # Placa final: la del verificador PP-OCRv6 cuando lee una placa ANT, porque es el lector
            # más preciso (96 % frente a 90 % del OCR rápido en placas reales, models/MODEL_CARD.md);
            # si no lee, la del OCR (consenso multi-cuadro, OCR profundo o lectura preliminar). Antes
            # varios votos de un error sistemático del OCR rápido (Y→V) podían imponerse a él.
            limpia_verificador = placa_verificador.replace("-", "").upper() if placa_verificador else ""
            limpia_profunda = (profundo.placa or "").replace("-", "").upper() if profundo else ""
            if placa_verificador:
                if placa and placa.replace("-", "").upper() != limpia_verificador:
                    self._log.info("[VERIFICADOR] Track #%d | el OCR leyó '%s'; se registra la lectura del verificador '%s'",
                                   tracking_id, placa, placa_verificador)
                placa, conf = placa_verificador, conf_verificador

            # 3. Compuerta estricta: sin matrícula ANT válida se audita el descarte
            limpia = placa.replace("-", "").strip().upper() if placa else ""
            if not limpia or len(limpia) < 4:
                texto = (profundo.placa if profundo else placa_previa) or ""
                if self._liberar_para_reintento(tracking_id):
                    self._log.info("[SEGUNDA VERIFICACIÓN OCR] Track #%d: foto ilegible (texto: '%s'); se intentará con otro cuadro", tracking_id, texto)
                    return
                # Sin más intentos: se audita una sola vez por track como falso positivo prevenido
                self._log.info("[SEGUNDA VERIFICACIÓN OCR] Falso positivo prevenido | Track #%d descartado (texto: '%s')", tracking_id, texto)
                self._descartar(tracking_id, "segunda_verificacion_ocr_no_valido", texto or None, profundo.confianza if profundo else conf_previa)
                return

            # 3.0 Validez de la lectura (evidencias independientes, ver verificacion_placa.py): formato
            #     ANT, placa completa dentro del cuadro, fila de caracteres plausible y confirmación
            #     por consenso multi-cuadro o por el segundo OCR. Solo una lectura válida puede
            #     autorizarse sin intervención.
            alto, ancho = frame.shape[:2]
            caja = [int(v) for v in candidato.plate_bbox]
            es_moto = (caja[2] - caja[0]) / max(1.0, float(caja[3] - caja[1])) <= 1.45
            recorte, origen = recorte_con_margen(frame, caja)
            analisis = analizar_caracteres(recorte, min_caracteres=2 if es_moto else MIN_CARACTERES)
            previo = pipeline.mejor_analisis(tracking_id) if pipeline else None
            if previo and (previo.valida, previo.caracteres, previo.puntaje) > (analisis.valida, analisis.caracteres, analisis.puntaje):
                analisis = previo
            # E4 · confirmación. Lecturas: cuadros del track leídos por el OCR con esta placa (más la
            # del OCR profundo de esta foto). El verificador confirma solo si coincide con alguna
            # lectura OCR independiente: una lectura no se confirma a sí misma.
            lecturas = int(conteo_previo.get(limpia, 0)) + (1 if limpia_profunda == limpia else 0)
            verificador_coincide = bool(limpia_verificador) and (
                limpia_verificador == limpia_profunda or int(conteo_previo.get(limpia_verificador, 0)) >= 1)
            validez = evaluar_lectura(
                formato_valido=validate_ecuadorian_plate(placa)[0],
                bbox=caja, ancho_img=ancho, alto_img=alto, analisis=analisis,
                lecturas_concordantes=lecturas, verificador_coincide=verificador_coincide,
            )
            self._log.info(
                "[VALIDEZ] Track #%d | %s | válida=%s | caracteres=%d lecturas=%d verificador=%s | %s",
                tracking_id, placa, validez.valido, analisis.caracteres, lecturas,
                verificador_coincide, "; ".join(validez.motivos) or "todas las evidencias",
            )

            # Compuerta "no es placa": sin fila de caracteres y sin ninguna confirmación (rótulos,
            # rejillas, franja "ECUADOR"…). Se libera el track para que un cuadro posterior lo intente.
            if analisis.caracteres < 3 and lecturas < 2 and not verificador_coincide:
                if self._liberar_para_reintento(tracking_id):
                    self._log.info("[VALIDEZ] Track #%d: foto sin fila de caracteres ('%s'); se intentará con otro cuadro", tracking_id, placa)
                    return
                self._log.info("[VALIDEZ] Track #%d descartado: región sin fila de caracteres ('%s')", tracking_id, placa)
                self._descartar(tracking_id, "region_sin_caracteres", placa, conf)
                return

            cuadrilatero = cuadrilatero_placa(caja, analisis, ancho, alto, origen) if not es_moto else None
            evidencia = {
                **validez.to_dict(),
                "angulo": round(analisis.angulo, 1),
                "regularidad": analisis.puntaje,
                "bordes_hallados": analisis.bordes_hallados,
                "cuadrilatero": cuadrilatero,
                "lectura_ocr": limpia_profunda or None,
                "lectura_verificador": limpia_verificador or None,
            }

            # 3.1 Anti-duplicado de la placa confirmada entre fases
            momento = time.time()
            with self._candado:
                hace = self._ya_registrada(limpia, momento)
                if hace is None:
                    self._placas_registradas[limpia] = momento
                    self._capturas_por_track[tracking_id] = momento
                    # Purga de los tres registros en memoria (operación 24/7 sin crecimiento)
                    horizonte = PLATE_DEBOUNCE_SECONDS * 2
                    purgar_expirados(self._placas_registradas, momento, horizonte)
                    purgar_expirados(self._capturas_por_track, momento, horizonte)
                    purgar_expirados(self._ultimo_intento_ocr, momento, horizonte)
                    self._intentos_captura = {k: v for k, v in self._intentos_captura.items() if momento - v[1] <= horizonte}
                    self._vehiculos = {k: v for k, v in self._vehiculos.items() if momento - v[1] <= horizonte}
            if hace is not None:
                self._log.info(
                    "[ANTI-DUPLICADO OCR] Track #%d placa confirmada '%s' ya registrada hace %.1fs. Omitiendo duplicado.",
                    tracking_id, limpia, hace,
                )
                return

            # El estado autorizado/alerta lo decide el backend al cruzar con las listas; aquí solo
            # se indica que la placa ya quedó registrada.
            if pipeline:
                pipeline.update_track_plate(tracking_id, "", 0.0, "confirmada")
                pipeline.update_browser_track_plate(tracking_id, "", 0.0, "confirmada")

            self._registrar_en_backend(candidato, tracking_id, frame, placa, conf, placa_verificador, validez, evidencia, ahora, etapas)
        except Exception as e:
            self._log.error("Error en compuerta de captura para track #%d: %s", tracking_id, e)
            self._m.record_detection_error("compuerta_captura")
        finally:
            # Si el intento se descartó, el análisis del vehículo que lanzó ya no hace falta (el
            # anticipado se conserva para un reintento del mismo track)
            if propio is not None:
                propio.cancel()

    def _registrar_en_backend(self, candidato: Any, tracking_id: int, frame: np.ndarray, placa: str, conf: float,
                              placa_verificador: str, validez: Any, evidencia: dict, ahora: float,
                              etapas: Optional[dict] = None) -> None:
        """4. Evidencia fotográfica en disco y 5. registro en dos fases en el backend."""
        pipeline = self._pipeline
        sello = time.strftime("%Y%m%d_%H%M%S")
        caja = getattr(candidato, "plate_bbox", [0, 0, 0, 0])
        x_caja = caja[0] if (caja and len(caja) > 0) else 0
        foto = f"ingreso_{sello}_{x_caja}_{int(candidato.timestamp * 1000) % 10000}.jpg"
        ruta_ingreso = f"/media/{foto}"
        self._dep.guardar_imagen(os.path.join(self._dir_media, foto), frame)

        x1, y1, x2, y2 = caja
        alto, ancho = frame.shape[:2]
        recorte = frame[max(0, y1):min(alto, y2), max(0, x1):min(ancho, x2)]
        foto_placa = f"placa_{sello}_{tracking_id}.jpg"
        ruta_placa = f"/media/{foto_placa}"
        if recorte.size > 0:
            self._dep.guardar_imagen(os.path.join(self._dir_media, foto_placa), recorte)
        else:
            ruta_placa = ruta_ingreso

        # Metadatos para evaluar por condición (luz, distancia, velocidad) y para saber qué versión
        # de los modelos produjo cada lectura (reproducibilidad)
        nacimiento, velocidad = pipeline.track_eval_info(tracking_id) if pipeline else (None, None)
        modelos = self.info_modelos()
        # Segundo factor: tipo, color, marca y modelo del vehículo (calculado en paralelo con el OCR)
        etapas = etapas or {}
        duraciones: dict[str, int] = {}
        for nombre, futuro in etapas.items():
            if nombre != "vehiculo" and futuro.done() and not futuro.cancelled() and futuro.exception() is None:
                duraciones[nombre] = int(futuro.result()[1])
        vehiculo = None
        if "vehiculo" in etapas:
            try:
                atributos, ms = etapas["vehiculo"].result()
                vehiculo = atributos.to_dict()
                duraciones["vehiculo"] = int(ms)
                self._log.info("[VEHÍCULO] Track #%d | %s", tracking_id, vehiculo)
            except Exception as e:
                self._log.warning("No se pudieron obtener atributos del vehículo (track #%d): %s", tracking_id, e)
        evidencia = {**evidencia, "etapas_ms": duraciones}
        ingreso = {
            "tracking_id": tracking_id,
            "placa": placa,
            "ruta_imagen_ingreso": ruta_ingreso,
            "confianza_deteccion": round(candidato.confidence, 3),
            "fuente": self.fuente_camara,
            "camara_id": self.camara_id,
            "metadatos": {
                "luminancia_media": round(float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean()), 1),
                "distancia_estimada_m": getattr(candidato, "estimated_distance_m", None),
                "ancho_placa_px": int(caja[2] - caja[0]) if caja and len(caja) == 4 else None,
                "nitidez": round(float(getattr(candidato, "sharpness", 0.0)), 1),
                "velocidad_px_s": velocidad,
                "modelo_detector": modelos.get("detector"),
                "modelo_ocr": " + ".join(m for m in (modelos.get("ocr_engine"), modelos.get("ocr_verifier")) if m) or None,
                "vehiculo": vehiculo,
            },
        }
        self._m.record_detection_confidence(float(candidato.confidence))
        self._m.record_ocr_confidence(float(conf))
        self._m.record_plate_recognized("valida" if validez.valido else "no_confirmada")

        res = self._http.post(f"{self._config.backend_url}/api/detecciones/ingreso", json=ingreso)
        if res.status_code not in (200, 201):
            self._log.warning("Fallo al registrar ingreso confirmado en backend: %s", res.text)
            return
        datos = res.json()
        ingreso_id = datos.get("ingreso_id")
        if datos.get("deduplicado", False):
            self._log.info("[BACKEND DEDUPLICADO] Ingreso ID #%d consolidado para Track #%d | Placa: %s", ingreso_id, tracking_id, placa)
            return
        if not ingreso_id:
            return

        # Latencia de principio a fin: desde que el vehículo apareció (nacimiento del track) hasta
        # que su lectura queda registrada; sin track, desde la captura del mejor cuadro.
        inicio = nacimiento or getattr(candidato, "timestamp", None) or ahora
        latencia_s = time.time() - inicio
        self._m.record_recognition_latency(latencia_s)
        self._log.info("[LATENCIA] Track #%d | %.0f ms desde que apareció | etapas (en paralelo): %s",
                       tracking_id, latencia_s * 1000, duraciones)
        res_ocr = self._http.post(f"{self._config.backend_url}/api/detecciones/completar-ocr", json={
            "ingreso_id": ingreso_id,
            "placa_reconocida": placa,
            "confianza_ocr": round(conf, 3),
            "ruta_imagen_placa": ruta_placa,
            "estado_procesamiento": "procesado",
            "lectura_verificador": placa_verificador or None,
            "latencia_ms": int(latencia_s * 1000),
            "lectura_valida": validez.valido,
            "evidencia_lectura": evidencia,
        })
        # El color de la caja en vivo refleja la decisión del backend
        estado_final = None
        try:
            estado_final = (res_ocr.json().get("deteccion") or {}).get("estado_validacion")
            if estado_final and pipeline:
                pipeline.fijar_estado_backend(tracking_id, estado_final)
        except Exception:
            pass
        self._m.record_detection(estado_final or "registrada", str(self.camara_id))
        self._log.info("CAPTURA REGISTRADA ECU 911 | Ingreso ID #%d | Track #%d | Placa: %s (%.1f%%)", ingreso_id, tracking_id, placa, conf * 100)
