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
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as TiempoAgotado
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import cv2
import numpy as np

from app.aplicacion.detector import _ESTADOS_FINALES, compute_crop_sharpness
from app.dominio.latencia import Cronometros, VentanaDescartes, VentanaLatencia
from app.aplicacion.verificacion_placa import (
    MIN_CARACTERES,
    analizar_caracteres,
    cuadrilatero_placa,
    evaluar_lectura,
    recorte_con_margen,
    toca_borde_lateral,
)
from app.dominio.credenciales import sin_credenciales
from app.dominio.ecuador_plate_validator import formato_coherente_con_la_placa, validate_ecuadorian_plate
from app.dominio.interpretacion_placa import caracteres_sin_lectura_directa
from app.dominio.memoria import purgar_expirados
from app.dominio.tasa_cuadros import TasaCuadros

# Ventana en la que un mismo vehículo (track o placa) no se registra dos veces
PLATE_DEBOUNCE_SECONDS = 35.0
#: Lecturas concordantes del OCR rápido para omitir un duplicado antes del OCR profundo
_LECTURAS_ANTIDUPLICADO_TEMPRANO = 2
#: Esperas entre reintentos de un envío al backend (0 = primer intento)
_ESPERAS_REINTENTO_S = (0.0, 0.5, 1.5)
#: Tiempo tras el cual se olvida una pista resuelta que ya no se ve
_HORIZONTE_PISTA_S = 3600.0
# Lecturas rápidas crudas que se conservan por pista como evidencia de lectura directa
_MAX_CRUDOS_POR_PISTA = 12
# Del presupuesto del registro se reserva este tiempo para guardar las fotos y enviar el ingreso y la
# lectura al backend (≈ 0,1 s medido en el portátil de desarrollo, con margen)
_RESERVA_REGISTRO_S = 0.25
# Enfriamiento entre lecturas OCR rápidas de un mismo track. El OCR rápido cuesta ~25 ms: con
# 0,25 s el consenso de 2–3 lecturas se forma en menos de medio segundo.
ENFRIAMIENTO_OCR_S = 0.25
# Valor de `fuente` que se envía al backend: el tipo de entrada, nunca la URL (lleva credenciales);
# la cámara de origen va en camara_id
FUENTE_RTSP = "rtsp"
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
    #: La clasificación visual del vehículo no se usa mientras su precisión no esté validada.
    analizar_vehiculo: bool = False
    #: Fotos de un mismo track que se prueban antes de descartarlo (1: sin reintento)
    intentos_captura: int = MAX_INTENTOS_CAPTURA
    #: Enfriamiento entre lecturas OCR rápidas de un track RTSP
    enfriamiento_ocr_s: float = ENFRIAMIENTO_OCR_S
    #: Espera máxima por la lectura del verificador desde que empieza a leer (OCR_VERIFIER_MAX_MS,
    #: su mismo presupuesto). Una lectura más larga se descarta igual por tardía: esperarla solo
    #: retrasaba el registro. None: sin tope.
    espera_verificador_s: Optional[float] = 2.0
    #: Tiempo máximo desde la captura de la foto hasta el registro del paso (REGISTRO_MAX_MS). Lo que
    #: no llegó a tiempo (segundo OCR, atributos del vehículo) se envía después como reevaluación y
    #: el backend decide de nuevo. None: el registro espera a todas las etapas (comportamiento anterior).
    presupuesto_registro_s: Optional[float] = 1.0
    #: Espera máxima por los atributos del vehículo en la reevaluación
    espera_vehiculo_s: float = 5.0


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


@dataclass
class _Pendiente:
    """Evidencias que el registro rápido no esperó; al llegar, se reevalúa el paso (fase 3)."""
    verificador: Optional[Future] = None
    inicio_verificador: dict = field(default_factory=dict)
    descripcion_verificador: str = ""
    #: Lo necesario para recalcular la validez con el segundo OCR, como si hubiera llegado a tiempo
    contexto: dict = field(default_factory=dict)


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
        # Reevaluaciones (segundo OCR y vehículo tardíos): aparte, para no demorar el registro siguiente
        self._ejecutor_reevaluacion = ThreadPoolExecutor(max_workers=2, thread_name_prefix="Reevaluacion")

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
        #: Pistas con el paso ya resuelto (registrado, consolidado por el backend o descartado tras
        #: agotar los intentos): no se vuelven a disparar mientras sigan vivas, aunque el vehículo
        #: siga detenido frente a la cámara. Los ids de pista no se repiten dentro del proceso.
        self._pistas_resueltas: dict[int, float] = {}
        #: Placa registrada de cada pista resuelta: mientras la pista siga a la vista, la ventana
        #: anti-duplicados de esa placa se cuenta desde el último avistamiento, no desde el registro
        self._placa_de_pista: dict[int, str] = {}
        #: Pistas vistas en el último cuadro analizado (un reintento solo es posible si sigue a la vista)
        self._pistas_activas: set[int] = set()
        #: Texto crudo de las lecturas rápidas de cada pista (otros cuadros), antes de interpretar
        #: confusiones: evidencia de que un carácter se leyó tal cual. (lecturas, hora de la última)
        self._crudos_rapidos: dict[int, tuple[list[str], float]] = {}

        # Cuadro compartido entre el productor y el consumidor: un solo lugar (el más reciente), con
        # su hora de captura; los intermedios que no alcanzan a analizarse se descartan y se cuentan
        self._candado_cuadro = threading.Lock()
        self._cuadro_compartido: Optional[np.ndarray] = None
        self._indice_cuadro = 0
        self._hora_cuadro = 0.0
        self._ultimo_seq_publicado: Any = None
        self._ultimo_tomado = -1
        self._cuadro_nuevo = threading.Event()
        #: Hora de captura de los últimos cuadros analizados (índice → hora), para el registro
        self._horas_cuadro: dict[int, float] = {}

        # Latencia de tiempo real y duración de las etapas (app/dominio/latencia.py)
        self._tiempos = Cronometros()
        self._lat_edad = VentanaLatencia(300)
        self._lat_vivo = VentanaLatencia(200)
        self._lat_registro = VentanaLatencia(100)
        self._descartes = VentanaDescartes(300)

        self._candado_cambio_camara = threading.Lock()

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
            "enlace_video": self._enlace_video(),
            "latencia": self.latencia(),
            "etapas_ms": self.etapas(),
            **self.info_modelos(),
            "architecture": "Two-Phase: Fast Capture + Async OCR",
        }

    def latencia(self) -> dict:
        """Latencia desde la captura de cada cuadro (percentiles de las últimas mediciones)."""
        return {
            "edad_cuadro": self._lat_edad.resumen(),
            "lectura_en_vivo": self._lat_vivo.resumen(),
            "registro": self._lat_registro.resumen(),
            "cuadros_descartados_pct": self._descartes.porcentaje(),
        }

    def etapas(self) -> dict:
        """Duración de cada etapa (percentiles): análisis del cuadro en el pipeline y, en el motor,
        OCR rápido, etapas del registro, envíos al backend y dibujo del HUD."""
        tiempos = getattr(self._pipeline, "tiempos", None)
        return {**(tiempos.resumen() if tiempos is not None else {}), **self._tiempos.resumen()}

    def _enlace_video(self) -> Optional[dict]:
        """Salud del enlace con la fuente RTSP: códec, resolución, cuadros recibidos y reconexiones."""
        try:
            info = self._fuente.source_info if self._fuente is not None else None
        except Exception:
            info = None
        if not info or info.get("type") != "rtsp":
            return None
        return {"codec": info.get("codec"), "ancho": info.get("width"), "alto": info.get("height"),
                "fps_recibidos": info.get("fps_recibidos"), "reconexiones": info.get("reconexiones"),
                "ultimo_cuadro_hace_s": info.get("ultimo_cuadro_hace_s")}

    def camara_activa(self) -> dict:
        conectada = self._fuente.is_connected if self._fuente else False
        if not conectada and self._fps_captura >= 10.0:
            conectada = True
        return {
            "camera_id": self.camara_id,
            "camera_source": sin_credenciales(self.fuente_camara),
            "is_connected": conectada,
            "roi": self._pipeline.roi if self._pipeline else None,
            "exclusiones": self._pipeline.exclusiones if self._pipeline else [],
        }

    def pistas_actuales(self) -> dict:
        """Cajas de detección vigentes y zona de movimiento, normalizadas a 0–1 respecto del
        cuadro de la fuente (velocidades en fracción del cuadro por segundo)."""
        w, h = self.tamano_fuente["w"], self.tamano_fuente["h"]
        pipeline = self._pipeline
        if not pipeline or not w or not h:
            return {"pistas": [], "roi": pipeline.roi if pipeline else None,
                    "exclusiones": pipeline.exclusiones if pipeline else [], "movimiento": None}
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
        # Proporción del cuadro que analiza el motor: el navegador avisa si la vista (flujo
        # secundario) tiene otra y los recuadros no coincidirían con el video
        return {"pistas": pistas, "roi": pipeline.roi, "exclusiones": pipeline.exclusiones,
                "movimiento": movimiento, "aspecto": round(w / h, 4)}

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
        if self._config.analizar_vehiculo:
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
        self._ejecutor_reevaluacion.shutdown(wait=False)
        self._http.close()
        self._log.info("Servicio ANPR cerrado limpiamente.")

    # ─── OCR rápido asíncrono ───────────────────────────────────────────────

    def encolar_ocr(self, tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int], hora_captura: Optional[float] = None) -> None:
        """OCR rápido de un track en un pool aparte, con enfriamiento: el seguimiento y el video
        nunca esperan al OCR. Con la hora de captura del cuadro se mide cuánto tarda la lectura en
        estar disponible para el HUD."""
        clave = tracking_id
        enfriamiento = self._config.enfriamiento_ocr_s
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
                    t_ocr = time.perf_counter()
                    res = trabajador._agent.process_image(frame_copy, plate_bbox, fast_mode=True)
                    self._tiempos.registrar("ocr_rapido", time.perf_counter() - t_ocr)
                    if res.placa:
                        crudo = getattr(res, "texto_crudo", None)
                        if crudo:
                            with self._candado:
                                previas = self._crudos_rapidos.get(tracking_id, ([], 0.0))[0]
                                self._crudos_rapidos[tracking_id] = ((previas + [crudo])[-_MAX_CRUDOS_POR_PISTA:], time.time())
                        estado = "leida" if res.estado == "procesado" else "escaneando"
                        pipeline.update_track_plate(tracking_id, res.placa, res.confianza, estado,
                                                    quality=nitidez_recorte(frame_copy, plate_bbox))
                        if estado == "leida" and hora_captura:
                            demora = time.time() - hora_captura
                            self._lat_vivo.registrar(demora)
                            self._m.record_capture_to_reading("vivo", demora)
            except Exception as e:
                self._log.warning("Aviso en OCR asíncrono para track #%d: %s", tracking_id, e)
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

            tomado = self._tomar_cuadro()
            if tomado is None:
                continue
            frame, idx, hora = tomado
            ultimo_procesado = idx

            try:
                # 1. Detección y seguimiento (actualiza los overlays del pipeline @ 512 px)
                rois = pipeline.detect_and_track(frame, imgsz=512)
                activos = {roi.tracking_id for roi in rois}
                self._renovar_pasos(activos)
                self._m.update_tracking_active(len(activos))
                self._m.record_inference("rtsp", pipeline.inferencia_omitida("rtsp"))

                # 2. OCR asíncrono de cada track y análisis anticipado del vehículo
                self._leer_placas(pipeline, rois, frame, hora)

                # 3. Calidad del cuadro y disparo de la captura fotográfica
                self._evaluar_capturas(selector, rois, frame, idx)
            except Exception as e:
                self._log.error("Error en hilo de detección desacoplado: %s", e)
                self._m.record_detection_error("deteccion")

    def _tomar_cuadro(self) -> Optional[tuple[np.ndarray, int, float]]:
        """El cuadro más reciente aún no analizado, con su índice y su hora de captura (None si no
        hay uno nuevo). Cuenta los cuadros que llegaron entre dos análisis y no alcanzaron a
        analizarse (descartados a propósito: siempre se procesa el último) y la edad del cuadro."""
        with self._candado_cuadro:
            if self._cuadro_compartido is None or self._indice_cuadro == self._ultimo_tomado:
                return None
            frame = self._cuadro_compartido.copy()
            idx, hora = self._indice_cuadro, self._hora_cuadro
            perdidos = idx - self._ultimo_tomado - 1 if self._ultimo_tomado >= 0 else 0
            self._ultimo_tomado = idx
        self._descartes.registrar(perdidos)
        self._m.record_frames_dropped(perdidos)
        edad = max(0.0, time.time() - hora)
        self._lat_edad.registrar(edad)
        self._m.record_frame_age(edad)
        self._horas_cuadro[idx] = hora
        if len(self._horas_cuadro) > 600:
            for viejo in [k for k in self._horas_cuadro if k < idx - 600]:
                del self._horas_cuadro[viejo]
        return frame, idx, hora

    def _publicar_cuadro(self, frame: np.ndarray, seq: Any, hora: float) -> bool:
        """Entrega el cuadro al hilo de detección si es nuevo (el lector puede repetir el último
        mientras no llega otro: no se vuelve a analizar). Devuelve True si lo publicó."""
        if seq is not None and seq == self._ultimo_seq_publicado:
            return False
        self._ultimo_seq_publicado = seq
        with self._candado_cuadro:
            self._cuadro_compartido = frame
            self._indice_cuadro += 1
            self._hora_cuadro = hora
        self._cuadro_nuevo.set()
        return True

    def _leer_placas(self, pipeline: Any, rois: list, frame: np.ndarray, hora: Optional[float] = None) -> None:
        """OCR asíncrono de cada track hasta reunir 3 lecturas concordantes (la evidencia de consenso
        multi-cuadro que exige la validez de la lectura). Una placa cortada por el borde lateral o
        demasiado pequeña no se lee: el OCR devolvería texto truncado ("SY589" por "PSY589")."""
        for roi in rois:
            info = pipeline.get_track_info(roi.tracking_id)
            if (info.get("lecturas", 0) < 3 and info.get("status") not in _ESTADOS_FINALES
                    and leible(roi.plate_bbox, frame, ancho_min=16, alto_min=6)):
                self.encolar_ocr(roi.tracking_id, frame.copy(), roi.plate_bbox, hora)
            self._anticipar_vehiculo(roi, frame)

    def _anticipar_vehiculo(self, roi: Any, frame: np.ndarray) -> None:
        """
        Inicia el análisis del vehículo (tipo, color, marca) en cuanto un track en movimiento tiene
        la placa completa dentro del cuadro, en paralelo con la espera del mejor cuadro de la placa:
        el resultado no depende de esa foto y así no alarga el registro (era su etapa más lenta).
        """
        tid = roi.tracking_id
        if not self._config.analizar_vehiculo or not self._config.vehiculo_anticipado or not getattr(roi, "en_movimiento", False) or tid in self._vehiculos:
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
        # Cuadros por segundo de la fuente: solo cuadros nuevos (read_frame puede repetir el último
        # hasta 3 s) y 0 si dejan de llegar, para que el estado de la cámara no quede congelado
        tasa = TasaCuadros()
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
                self._fps_captura = round(tasa.valor, 1)
                fallos_seguidos += 1
                if fallos_seguidos >= 40 and fallos_seguidos % 30 == 0:
                    self.buffer_video.update(self._dep.cuadro_espera(getattr(fuente, "_name", "Canal Activo")))
                time.sleep(0.02)
                continue

            fallos_seguidos = 0
            seq = getattr(fuente, "frame_seq", None)
            hora = getattr(fuente, "hora_entregada", None) or time.time()
            if not self._publicar_cuadro(frame, seq, hora):
                # El mismo cuadro otra vez: ni se vuelve a analizar ni se redibuja
                time.sleep(0.003)
                continue
            cuadros += 1
            tasa.registrar()
            self.tamano_fuente["h"], self.tamano_fuente["w"] = frame.shape[:2]

            if cuadros % 10 == 0:
                self._fps_captura = round(tasa.valor, 1)
                self._m.update_fps(self._fps_captura, str(self.camara_id))

            # HUD y buffer de video solo si alguien lo mira (ahorra CPU sin espectadores)
            if self._config.hud_activo and (ventana or self.buffer_video.viewers > 0):
                t_hud = time.perf_counter()
                anotado = pipeline.draw_overlays(frame.copy(), capture_fps=self._fps_captura, inference_fps=pipeline.fps)
                self._tiempos.registrar("dibujo_hud", time.perf_counter() - t_hud)
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

    # ─── Cámara y región de interés ─────────────────────────────────────────

    def cambiar_camara(self, payload: dict) -> tuple[int, dict]:
        """Cambia en caliente la cámara RTSP sin reiniciar el servicio. Devuelve (código HTTP, cuerpo).
        Solo se admiten fuentes RTSP: el motor no usa cámaras locales."""
        camera_id = int(payload.get("camera_id", 1))
        tipo = str(payload.get("source_type", "rtsp")).lower().strip()
        if tipo != "rtsp":
            return 400, {"success": False, "error": "Solo se admiten fuentes RTSP"}
        rtsp_url = payload.get("rtsp_url")
        nombre = payload.get("nombre", "Cámara Activa")
        forzar = bool(payload.get("force", False))
        # Zonas de la cámara (región de interés y zonas de exclusión): viajan juntas; si no llega
        # ninguna, no cambian. Las de la cámara anterior nunca se conservan con la nueva.
        if self._pipeline and ("roi" in payload or "exclusiones" in payload):
            self._pipeline.set_roi(payload.get("roi"))
            self._pipeline.set_exclusiones(payload.get("exclusiones"))

        self._log.info("Solicitud de cambio de cámara activa ANPR: ID %d | %s | %s | force=%s", camera_id, tipo, sin_credenciales(rtsp_url) or "", forzar)

        with self._candado_cambio_camara:
            anterior = self._fuente
            fuente_txt = rtsp_url or self._config.rtsp_url

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
                nueva = self._dep.fuente_rtsp(fuente_txt)
                nueva._name = nombre
                nueva._url = fuente_txt

                # Pantalla de transición inmediata: no se congela ni se muestra el canal anterior
                self.buffer_video.update(self._dep.cuadro_espera(nombre))

                self._fuente = nueva
                self.camara_id = camera_id
                self.fuente_camara = fuente_txt
                threading.Thread(target=nueva.connect, daemon=True, name="CamConnect").start()

                # Tracks, consensos, candidatos y la ventana anti-duplicados por placa pertenecen
                # al canal anterior (un registro en curso conserva la cámara con que se disparó)
                with self._candado:
                    self._placas_registradas.clear()
                    self._placa_de_pista.clear()
                    self._pistas_activas = set()
                    self._crudos_rapidos.clear()
                self._ultimo_seq_publicado = None
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
        """Zonas de la cámara activa: {"roi": [[x, y], …] o null, "exclusiones": [[[x, y], …], …]},
        normalizadas 0–1 (sin "exclusiones" estas no cambian)."""
        if not self._pipeline:
            return 503, {"error": "Motor no iniciado"}
        camara = payload.get("camara_id")
        if camara is not None and int(camara) != self.camara_id:
            # Pertenece a otra cámara: se aplicará cuando esa cámara se active
            return 200, {"success": True, "aplicada": False, "roi": self._pipeline.roi, "exclusiones": self._pipeline.exclusiones}
        roi = self._pipeline.set_roi(payload.get("roi"))
        if "exclusiones" in payload:
            self._pipeline.set_exclusiones(payload.get("exclusiones"))
        return 200, {"success": True, "aplicada": True, "roi": roi, "exclusiones": self._pipeline.exclusiones}

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
            # Paso ya resuelto: un vehículo detenido frente a la garita no se vuelve a registrar (ni
            # a auditar como descarte) mientras su pista siga viva
            if tracking_id in self._pistas_resueltas:
                return
            if tracking_id in self._capturas_por_track and (ahora - self._capturas_por_track[tracking_id] < PLATE_DEBOUNCE_SECONDS):
                return
            self._capturas_por_track[tracking_id] = ahora
        # La cámara del paso es la de este momento, aunque cambie mientras se registra
        camara = self.camara_id

        frame = candidato.frame.copy() if candidato.frame is not None else None
        if frame is None or frame.size == 0:
            return
        self._ejecutor_disco.submit(self._verificar_y_registrar, candidato, tracking_id, frame, ahora, camara)

    def _resolver_pista(self, tracking_id: int, placa: Optional[str] = None) -> None:
        """El paso de la pista quedó resuelto; con la placa, su ventana se renueva mientras siga a la vista."""
        ahora = time.time()
        with self._candado:
            self._pistas_resueltas[tracking_id] = ahora
            self._crudos_rapidos.pop(tracking_id, None)
            if placa:
                self._placa_de_pista[tracking_id] = placa
            if len(self._pistas_resueltas) > 500:
                viejas = [t for t, h in self._pistas_resueltas.items() if ahora - h > _HORIZONTE_PISTA_S]
                for t in viejas:
                    self._pistas_resueltas.pop(t, None)
                    self._placa_de_pista.pop(t, None)

    def _renovar_pasos(self, activos: set[int]) -> None:
        """Pistas a la vista en este cuadro. Mientras la de un paso registrado siga visible, la
        ventana anti-duplicados de su placa cuenta desde ahora: si el vehículo sigue detenido y su
        pista se pierde un momento (oclusión), la pista nueva no genera un segundo paso."""
        ahora = time.time()
        with self._candado:
            self._pistas_activas = set(activos)
            for tid in activos:
                placa = self._placa_de_pista.get(tid)
                if placa:
                    self._placas_registradas[placa] = ahora
                    self._pistas_resueltas[tid] = ahora

    def _revertir_reserva(self, tracking_id: int, placa: str, momento: float) -> None:
        """El backend no aceptó el ingreso: la placa y la pista dejan de figurar como registradas."""
        with self._candado:
            if self._placas_registradas.get(placa) == momento:
                del self._placas_registradas[placa]
            self._capturas_por_track.pop(tracking_id, None)
        if self._pipeline:
            self._pipeline.update_track_plate(tracking_id, "", 0.0, "leida")

    def _enviar(self, ruta: str, cuerpo: dict) -> Any:
        """POST al backend con reintentos ante fallos transitorios (red, 5xx, 429). Es seguro: el
        backend reconoce el mismo paso (misma placa y cámara dentro de su ventana)."""
        ultimo: Any = None
        for espera in _ESPERAS_REINTENTO_S:
            if espera:
                time.sleep(espera)
            try:
                res = self._http.post(f"{self._config.backend_url}{ruta}", json=cuerpo)
            except Exception as e:  # red caída o tiempo agotado
                ultimo = e
                continue
            if res.status_code < 500 and res.status_code != 429:
                return res
            ultimo = res
        if isinstance(ultimo, Exception):
            raise ultimo
        return ultimo

    def _ya_registrada(self, placa: str, ahora: float) -> Optional[float]:
        """Segundos desde que la placa se registró, si fue dentro de la ventana anti-duplicados."""
        registrada = self._placas_registradas.get(placa)
        return ahora - registrada if registrada is not None and ahora - registrada < PLATE_DEBOUNCE_SECONDS else None

    def _descartar(self, tracking_id: int, motivo: str, texto: Optional[str], confianza: float,
                   camara: Optional[int] = None) -> None:
        """Auditoría del descarte en el backend (un falso positivo no contamina la base). La pista
        queda resuelta: no se vuelve a intentar ni a auditar mientras siga viva."""
        camara = self.camara_id if camara is None else camara
        self._resolver_pista(tracking_id)
        self._m.record_detection("descartada", str(camara))
        try:
            self._http.post(
                f"{self._config.backend_url}/api/detecciones/descarte",
                json={
                    "tracking_id": tracking_id,
                    "motivo": motivo,
                    "texto_candidato": texto,
                    "confianza": round(confianza, 3),
                    "fuente": FUENTE_RTSP,
                    "camara_id": camara,
                },
                timeout=2.0,
            )
        except Exception:
            pass

    def _esperar_verificador(self, futuro: Future, inicio: dict[str, float], tracking_id: int,
                             limite: Optional[float] = None) -> tuple[Any, bool]:
        """
        (lectura del verificador, pendiente). Sin lectura (None) en dos casos:
          - su lectura ya excede su presupuesto: se descartaría por tardía, así que no se espera. El
            tiempo cuenta desde que el verificador empieza a leer (`inicio`), como su propio
            presupuesto: nunca se deja de esperar una lectura que habría llegado a tiempo;
          - vence el plazo del registro (`limite`, hora del reloj del sistema): pendiente=True, el
            paso se registra y la reevaluación la espera.
        El hilo del verificador termina por su cuenta.
        """
        tope = self._config.espera_verificador_s
        if tope is None and limite is None:
            return futuro.result()[0], False
        while True:
            empezado = inicio.get("t")
            restante = None if (tope is None or empezado is None) else tope - (time.monotonic() - empezado)
            if restante is not None and restante <= 0:
                self._log.info("[VERIFICADOR] Track #%d | su lectura supera %.0f ms: se registra sin esperarla", tracking_id, tope * 1000)
                self._m.record_ocr_error("verificador_fuera_de_tiempo")
                return None, False
            plazo = None if limite is None else limite - time.time()
            if plazo is not None and plazo <= 0:
                return None, True
            # En cola todavía (otro registro ocupa las etapas): se consulta de nuevo en 50 ms
            esperas = [x for x in (restante, plazo, 0.05 if empezado is None else None) if x is not None]
            try:
                return futuro.result(timeout=min(esperas) if esperas else None)[0], False
            except TiempoAgotado:
                continue

    def _validez(self, *, placa: str, limpia_profunda: str, limpia_verificador: str, crudo_verificador: Optional[str],
                 crudos: list, conteo_previo: dict, caja: list[int], ancho: int, alto: int, analisis: Any) -> tuple[Any, int, bool]:
        """
        Validez de la lectura (E1–E5, verificacion_placa.py) con las evidencias disponibles. La usan
        el registro y la reevaluación, para que el segundo OCR tardío se juzgue igual que a tiempo.
        """
        limpia = placa.replace("-", "").strip().upper()
        # E4 · confirmación. Lecturas: cuadros del track leídos por el OCR con esta placa (más la
        # del OCR profundo de esta foto). El verificador confirma solo si coincide con alguna
        # lectura OCR independiente: una lectura no se confirma a sí misma.
        lecturas = int(conteo_previo.get(limpia, 0)) + (1 if limpia_profunda == limpia else 0)
        verificador_coincide = bool(limpia_verificador) and (
            limpia_verificador == limpia_profunda or int(conteo_previo.get(limpia_verificador, 0)) >= 1)
        # E5 · lectura directa. Que dos lectores coincidan no basta si ambos coinciden gracias a la
        # misma sustitución (los dos leyeron "S" y el formato puso "5"): cada carácter de la placa
        # debe haberlo leído tal cual el OCR profundo, el verificador o el OCR rápido en otro
        # cuadro. Un lector que no informa su texto crudo (None) no participa.
        informados = [c for c in (*crudos, crudo_verificador) if c is not None]
        inferidos = caracteres_sin_lectura_directa(limpia, informados) if informados else []
        validez = evaluar_lectura(
            formato_valido=validate_ecuadorian_plate(placa)[0],
            bbox=caja, ancho_img=ancho, alto_img=alto, analisis=analisis,
            lecturas_concordantes=lecturas, verificador_coincide=verificador_coincide,
            caracteres_inferidos=inferidos,
        )
        return validez, lecturas, verificador_coincide

    def _reevaluar(self, ingreso_id: int, tracking_id: int, placa: str, conf: float, evidencia: dict,
                   pendiente: _Pendiente, vehiculo: Optional[Future], hora_foto: Optional[float]) -> None:
        """
        Fase 3 · el registro rápido no esperó al verificador o al análisis del vehículo. Cuando
        llegan, la lectura se recalcula con las mismas reglas que si hubieran llegado a tiempo (la
        placa del verificador prevalece si lee una placa ANT) y el backend decide de nuevo: puede
        confirmar el paso, rebajarlo por el segundo factor o pasarlo a alerta.
        """
        cuerpo: dict[str, Any] = {"ingreso_id": ingreso_id}
        try:
            if pendiente.verificador is not None:
                ver, _ = self._esperar_verificador(pendiente.verificador, pendiente.inicio_verificador, tracking_id)
                if ver is not None:
                    self._log.info("[VERIFICADOR %s] Track #%d | lectura tardía '%s' (%.2f) en %.0f ms%s",
                                   pendiente.descripcion_verificador, tracking_id, ver.plate or "-", ver.confidence, ver.elapsed_ms,
                                   "" if ver.within_budget else " — descartada por exceder el presupuesto")
                if ver is not None and ver.within_budget:
                    crudo = getattr(ver, "raw", None)
                    placa_v = ""
                    if ver.plate:
                        es_valida, formateada, _ = validate_ecuadorian_plate(ver.plate)
                        if es_valida:
                            placa_v = formateada
                    placa_final, conf_final = (placa_v, ver.confidence) if placa_v else (placa, conf)
                    limpia_v = placa_v.replace("-", "").upper()
                    validez, lecturas, coincide = self._validez(
                        placa=placa_final, limpia_verificador=limpia_v, crudo_verificador=crudo, **pendiente.contexto)
                    nueva = {k: v for k, v in evidencia.items() if k != "segundo_ocr_pendiente"}
                    nueva.update(validez.to_dict(), lectura_verificador=limpia_v or None, lectura_verificador_cruda=crudo or None)
                    cuerpo.update(placa_reconocida=placa_final, confianza_ocr=round(conf_final, 3), lectura_verificador=placa_v or None,
                                  lectura_valida=validez.valido, evidencia_lectura=nueva)
                    limpia_final = placa_final.replace("-", "").upper()
                    if limpia_final != placa.replace("-", "").upper():
                        self._log.info("[VERIFICADOR] Track #%d | el OCR leyó '%s'; se reevalúa con la lectura del verificador '%s'",
                                       tracking_id, placa, placa_final)
                        with self._candado:
                            self._placas_registradas[limpia_final] = time.time()
                            self._placa_de_pista[tracking_id] = limpia_final
                    self._log.info("[VALIDEZ REEVALUADA] Track #%d | %s | válida=%s | lecturas=%d verificador=%s | %s",
                                   tracking_id, placa_final, validez.valido, lecturas, coincide,
                                   "; ".join(validez.motivos) or "todas las evidencias")
            if vehiculo is not None:
                try:
                    atributos, ms = vehiculo.result(timeout=self._config.espera_vehiculo_s)
                    cuerpo["vehiculo"] = atributos.to_dict()
                    self._tiempos.registrar("registro_vehiculo", ms / 1000.0)
                    self._log.info("[VEHÍCULO] Track #%d | %s", tracking_id, cuerpo["vehiculo"])
                except TiempoAgotado:
                    self._log.warning("Atributos del vehículo sin respuesta en %.0f s (track #%d)", self._config.espera_vehiculo_s, tracking_id)
                    self._m.record_detection_error("vehiculo_fuera_de_tiempo")
                except Exception as e:
                    self._log.warning("No se pudieron obtener atributos del vehículo (track #%d): %s", tracking_id, e)
            if len(cuerpo) == 1:
                return
            res = self._enviar("/api/detecciones/reevaluar", cuerpo)
            if res is None or res.status_code >= 300:
                self._log.error("El backend no aceptó la reevaluación del ingreso #%d: %s", ingreso_id, getattr(res, "text", res))
                self._m.record_detection_error("backend")
                return
            estado = (res.json().get("deteccion") or {}).get("estado_validacion")
            if estado and self._pipeline:
                self._pipeline.fijar_estado_backend(tracking_id, estado)
            if hora_foto:
                self._m.record_capture_to_reading("reevaluacion", time.time() - hora_foto)
        except Exception as e:
            self._log.error("Error al reevaluar el ingreso #%d (track #%d): %s", ingreso_id, tracking_id, e)
            self._m.record_detection_error("reevaluacion")

    def _sin_reintento_posible(self, tracking_id: int) -> bool:
        """La pista ya no está a la vista: ningún cuadro posterior podrá reintentar su lectura."""
        with self._candado:
            return tracking_id not in self._pistas_activas

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

    def _verificar_y_registrar(self, candidato: Any, tracking_id: int, frame: np.ndarray, ahora: float,
                               camara: Optional[int] = None) -> None:
        etapas: dict[str, Any] = {}
        propio: Optional[Future] = None  # análisis del vehículo lanzado por este intento
        camara = self.camara_id if camara is None else camara
        try:
            pipeline = self._pipeline
            trabajador = self._trabajador_ocr
            # 1. Lectura previa del track (consenso del OCR rápido)
            info_rtsp = pipeline.get_track_info(tracking_id) if pipeline else {}
            placa_previa = info_rtsp.get("plate", "")
            conf_previa = info_rtsp.get("confidence", 0.0)
            # Lecturas de OTROS cuadros del track, antes de sumar las de este (para no contar dos
            # veces el mismo cuadro con el OCR profundo y el verificador)
            conteo_previo = pipeline.conteo_lecturas(tracking_id) if pipeline else {}

            # Anti-duplicado temprano, antes del OCR profundo y del disco: solo con un consenso de al
            # menos dos lecturas concordantes (una confusión aislada del OCR rápido, p. ej. 8→3, no
            # debe omitir a otro vehículo sin que lo lean el OCR profundo y el verificador)
            if placa_previa:
                limpia_previa = placa_previa.replace("-", "").strip().upper()
                with self._candado:
                    hace = self._ya_registrada(limpia_previa, time.time())
                if hace is not None and int(conteo_previo.get(limpia_previa, 0)) >= _LECTURAS_ANTIDUPLICADO_TEMPRANO:
                    self._log.info(
                        "[ANTI-DUPLICADO PRELIMINAR] Track #%d placa preliminar '%s' ya registrada hace %.1fs. Omitiendo captura.",
                        tracking_id, limpia_previa, hace,
                    )
                    self._resolver_pista(tracking_id, limpia_previa)
                    return

            # 2. OCR profundo (homografía + binarización adaptativa), segundo OCR (PP-OCRv6) y
            #    atributos del vehículo EN PARALELO: los tres parten de la misma foto y, uno tras
            #    otro, eran la mayor parte de la latencia del registro.
            agente = getattr(trabajador, "_agent", None) if trabajador else None
            verificador = self._dep.verificador()
            reconocedor = self._dep.reconocedor_vehiculo() if self._config.analizar_vehiculo else None
            caja_placa = [int(v) for v in candidato.plate_bbox]

            def lanzar(funcion: Callable, *args, **kwargs) -> Future:
                futuro = self._ejecutor_etapas.submit(_medido, funcion, *args, **kwargs)
                if not self._config.registro_paralelo:
                    futuro.exception()  # ablación: cada etapa espera a que termine la anterior
                return futuro

            if agente:
                etapas["ocr_profundo"] = lanzar(agente.process_image, frame, initial_bbox=candidato.plate_bbox, fast_mode=False)
            inicio_verificador: dict[str, float] = {}
            if verificador is not None:
                def leer_verificador(recorte: np.ndarray) -> Any:
                    inicio_verificador["t"] = time.monotonic()  # su presupuesto cuenta desde aquí
                    return verificador.read(recorte)

                etapas["verificador"] = lanzar(leer_verificador, recorte_con_holgura(frame, candidato.plate_bbox))
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

            # Fila de caracteres de la foto (E3, ≈ 5 ms): se analiza antes de esperar al verificador
            alto, ancho = frame.shape[:2]
            caja = [int(v) for v in candidato.plate_bbox]
            es_moto = (caja[2] - caja[0]) / max(1.0, float(caja[3] - caja[1])) <= 1.45
            recorte, origen = recorte_con_margen(frame, caja)
            analisis = analizar_caracteres(recorte, min_caracteres=2 if es_moto else MIN_CARACTERES)
            previo = pipeline.mejor_analisis(tracking_id) if pipeline else None
            if previo and (previo.valida, previo.caracteres, previo.puntaje) > (analisis.valida, analisis.caracteres, analisis.puntaje):
                analisis = previo

            # Registro rápido: con una placa ya leída y una fila de caracteres plausible, el paso se
            # registra dentro del presupuesto contado desde la captura de la foto, sin esperar al
            # verificador; su lectura llega después como reevaluación. Sin placa o con una foto dudosa
            # se espera al verificador como antes (es quien puede leerla o descartarla).
            # Una lectura con formato incoherente con la forma de la placa también espera al
            # verificador: su lectura puede ser la correcta (PJF001 donde el OCR leyó PJ001).
            presupuesto = self._config.presupuesto_registro_s
            candidata = placa or (placa_previa if placa_previa and validate_ecuadorian_plate(placa_previa)[0] else "")
            limite_registro: Optional[float] = None
            if (presupuesto is not None and candidata and analisis.caracteres >= 3
                    and formato_coherente_con_la_placa(candidata, es_moto)):
                hora_foto = self._horas_cuadro.get(getattr(candidato, "frame_idx", -1)) or ahora
                limite_registro = hora_foto + presupuesto - _RESERVA_REGISTRO_S

            # 2.1 Segunda lectura con PP-OCRv6 sobre la mejor foto: más precisa pero demasiado lenta
            #     para cada cuadro, así que solo una vez por vehículo
            placa_verificador, conf_verificador = "", 0.0
            crudo_verificador: Optional[str] = None
            ver, verificador_pendiente = (
                self._esperar_verificador(etapas["verificador"], inicio_verificador, tracking_id, limite=limite_registro)
                if "verificador" in etapas else (None, False))
            if verificador_pendiente:
                self._log.info("[REGISTRO RÁPIDO] Track #%d | plazo del registro alcanzado: se sigue sin esperar al verificador "
                               "(si el paso se registra, su lectura llega como reevaluación)", tracking_id)
            if ver is not None:
                if ver.within_budget:
                    crudo_verificador = getattr(ver, "raw", None)
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
                votar = pipeline.update_track_plate
                consultar = pipeline.get_track_info
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
            crudo_profundo = getattr(profundo, "texto_crudo", None) if profundo else None
            if not limpia or len(limpia) < 4:
                # En la auditoría queda el texto que se leyó, no una interpretación
                texto = ((crudo_profundo or profundo.placa) if profundo else placa_previa) or ""
                if self._liberar_para_reintento(tracking_id) and not self._sin_reintento_posible(tracking_id):
                    self._log.info("[SEGUNDA VERIFICACIÓN OCR] Track #%d: foto ilegible (texto: '%s'); se intentará con otro cuadro", tracking_id, texto)
                    return
                # Sin más intentos (o el vehículo ya salió): se audita una sola vez por track como
                # placa no legible / falso positivo prevenido
                self._log.info("[SEGUNDA VERIFICACIÓN OCR] Falso positivo prevenido | Track #%d descartado (texto: '%s')", tracking_id, texto)
                self._descartar(tracking_id, "segunda_verificacion_ocr_no_valido", texto or None,
                                profundo.confianza if profundo else conf_previa, camara)
                return

            # 3.0a Solo placas: la lectura debe corresponder a la forma de la placa (ver
            #      formato_coherente_con_la_placa). Si no, se trata como foto ilegible: otro cuadro del
            #      paso o, sin más intentos, se audita el descarte; no se registra un paso.
            if not formato_coherente_con_la_placa(placa, es_moto):
                if self._liberar_para_reintento(tracking_id) and not self._sin_reintento_posible(tracking_id):
                    self._log.info("[SOLO PLACAS] Track #%d: '%s' tiene formato de moto en una placa de auto; se intentará con otro cuadro",
                                   tracking_id, placa)
                    return
                self._log.info("[SOLO PLACAS] Track #%d descartado: '%s' tiene formato de moto en una placa de auto (no es una placa o falta un carácter)",
                               tracking_id, placa)
                self._descartar(tracking_id, "formato_no_corresponde_a_la_placa", placa, conf, camara)
                return

            # 3.0 Validez de la lectura (evidencias independientes, ver verificacion_placa.py y
            #     _validez): solo una lectura válida puede autorizarse sin intervención.
            with self._candado:
                crudos_rapidos = list(self._crudos_rapidos.get(tracking_id, ([], 0.0))[0])
            contexto = {
                "limpia_profunda": limpia_profunda, "crudos": [crudo_profundo, *crudos_rapidos], "conteo_previo": conteo_previo,
                "caja": caja, "ancho": ancho, "alto": alto, "analisis": analisis,
            }
            validez, lecturas, verificador_coincide = self._validez(
                placa=placa, limpia_verificador=limpia_verificador, crudo_verificador=crudo_verificador, **contexto)
            self._log.info(
                "[VALIDEZ] Track #%d | %s | válida=%s | caracteres=%d lecturas=%d verificador=%s | %s",
                tracking_id, placa, validez.valido, analisis.caracteres, lecturas,
                verificador_coincide, "; ".join(validez.motivos) or "todas las evidencias",
            )

            # Compuerta "no es placa": sin fila de caracteres y sin ninguna confirmación (rótulos,
            # rejillas, franja "ECUADOR"…). Se libera el track para que un cuadro posterior lo intente.
            if analisis.caracteres < 3 and lecturas < 2 and not verificador_coincide:
                if self._liberar_para_reintento(tracking_id) and not self._sin_reintento_posible(tracking_id):
                    self._log.info("[VALIDEZ] Track #%d: foto sin fila de caracteres ('%s'); se intentará con otro cuadro", tracking_id, placa)
                    return
                self._log.info("[VALIDEZ] Track #%d descartado: región sin fila de caracteres ('%s')", tracking_id, placa)
                self._descartar(tracking_id, "region_sin_caracteres", placa, conf, camara)
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
                # Salida cruda de cada lector (antes de interpretar confusiones)
                "lectura_ocr_cruda": crudo_profundo or None,
                "lectura_verificador_cruda": crudo_verificador or None,
                "lecturas_rapidas_crudas": [t for t, _ in Counter(crudos_rapidos).most_common(4)] or None,
            }
            if verificador_pendiente:
                evidencia["segundo_ocr_pendiente"] = True

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
                    self._crudos_rapidos = {k: v for k, v in self._crudos_rapidos.items() if momento - v[1] <= horizonte}
            if hace is not None:
                self._log.info(
                    "[ANTI-DUPLICADO OCR] Track #%d placa confirmada '%s' ya registrada hace %.1fs. Omitiendo duplicado.",
                    tracking_id, limpia, hace,
                )
                # Mismo paso físico que uno ya registrado: la pista queda resuelta con esa placa
                self._resolver_pista(tracking_id, limpia)
                return

            # El estado autorizado/alerta lo decide el backend al cruzar con las listas; aquí solo
            # se indica que la placa ya quedó registrada.
            if pipeline:
                pipeline.update_track_plate(tracking_id, "", 0.0, "confirmada")

            pendiente = _Pendiente(verificador=etapas["verificador"], inicio_verificador=inicio_verificador,
                                   descripcion_verificador=getattr(verificador, "description", ""),
                                   contexto=contexto) if verificador_pendiente else None
            if self._registrar_en_backend(candidato, tracking_id, frame, placa, conf, placa_verificador, validez, evidencia, ahora,
                                          etapas, camara=camara, limpia=limpia, momento=momento, pendiente=pendiente):
                propio = None  # el análisis del vehículo lo espera la reevaluación
        except Exception as e:
            self._log.error("Error en compuerta de captura para track #%d: %s", tracking_id, e)
            self._m.record_detection_error("compuerta_captura")
            # Un fallo inesperado (OCR, verificador, disco) no deja la pista bloqueada: se reintenta
            # con otro cuadro si sigue a la vista; si no, se audita
            if not self._liberar_para_reintento(tracking_id) or self._sin_reintento_posible(tracking_id):
                self._descartar(tracking_id, "error_interno", None, 0.0, camara)
        finally:
            # Si el intento se descartó, el análisis del vehículo que lanzó ya no hace falta (el
            # anticipado se conserva para un reintento del mismo track)
            if propio is not None:
                propio.cancel()

    def _registrar_en_backend(self, candidato: Any, tracking_id: int, frame: np.ndarray, placa: str, conf: float,
                              placa_verificador: str, validez: Any, evidencia: dict, ahora: float,
                              etapas: Optional[dict] = None, camara: Optional[int] = None,
                              limpia: Optional[str] = None, momento: Optional[float] = None,
                              pendiente: Optional[_Pendiente] = None) -> bool:
        """
        4. Evidencia fotográfica en disco y 5. registro en dos fases en el backend. Con el registro
        rápido no se espera al análisis del vehículo: lo pendiente se reevalúa después. True si
        quedó una reevaluación en curso (se queda con el análisis del vehículo).
        """
        pipeline = self._pipeline
        camara = self.camara_id if camara is None else camara
        limpia = limpia or placa.replace("-", "").strip().upper()
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
        vehiculo_pendiente: Optional[Future] = None
        if "vehiculo" in etapas and self._config.presupuesto_registro_s is not None and not etapas["vehiculo"].done():
            vehiculo_pendiente = etapas["vehiculo"]  # llega como reevaluación: el registro no lo espera
        elif "vehiculo" in etapas:
            try:
                atributos, ms = etapas["vehiculo"].result()
                vehiculo = atributos.to_dict()
                duraciones["vehiculo"] = int(ms)
                self._log.info("[VEHÍCULO] Track #%d | %s", tracking_id, vehiculo)
            except Exception as e:
                self._log.warning("No se pudieron obtener atributos del vehículo (track #%d): %s", tracking_id, e)
        evidencia = {**evidencia, "etapas_ms": duraciones}
        for nombre, ms in duraciones.items():
            self._tiempos.registrar(f"registro_{nombre}", ms / 1000.0)
        ingreso = {
            "tracking_id": tracking_id,
            "placa": placa,
            "ruta_imagen_ingreso": ruta_ingreso,
            "confianza_deteccion": round(candidato.confidence, 3),
            "fuente": FUENTE_RTSP,
            "camara_id": camara,
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

        t_http = time.perf_counter()
        try:
            res = self._enviar("/api/detecciones/ingreso", ingreso)
        except Exception as e:
            res, error = None, e
        self._tiempos.registrar("registro_http_ingreso", time.perf_counter() - t_http)
        if res is None or res.status_code not in (200, 201):
            # El backend no aceptó el paso: no queda como registrado (la placa podrá registrarse con
            # otro cuadro de la pista o con el próximo paso) y el fallo se cuenta
            self._log.error("Fallo al registrar el ingreso del track #%d en el backend: %s", tracking_id,
                            res.text if res is not None else error)
            self._m.record_detection_error("backend")
            if momento is not None:
                self._revertir_reserva(tracking_id, limpia, momento)
            if not self._liberar_para_reintento(tracking_id) or self._sin_reintento_posible(tracking_id):
                self._descartar(tracking_id, "backend_no_disponible", placa, conf, camara)
            return
        datos = res.json()
        ingreso_id = datos.get("ingreso_id")
        if datos.get("deduplicado", False):
            self._log.info("[BACKEND DEDUPLICADO] Ingreso ID #%d consolidado para Track #%d | Placa: %s", ingreso_id, tracking_id, placa)
            # Las fotos de este intento no las referencia ninguna fila
            for nombre in {foto, foto_placa}:
                try:
                    os.remove(os.path.join(self._dir_media, nombre))
                except OSError:
                    pass
            self._resolver_pista(tracking_id, limpia)
            return
        if not ingreso_id:
            return
        self._resolver_pista(tracking_id, limpia)

        # Latencia de principio a fin: desde que el vehículo apareció (nacimiento del track) hasta
        # que su lectura queda registrada; sin track, desde la captura del mejor cuadro.
        inicio = nacimiento or getattr(candidato, "timestamp", None) or ahora
        latencia_s = time.time() - inicio
        self._m.record_recognition_latency(latencia_s)
        self._log.info("[LATENCIA] Track #%d | %.0f ms desde que apareció | etapas (en paralelo): %s",
                       tracking_id, latencia_s * 1000, duraciones)
        t_http = time.perf_counter()
        try:
            res_ocr = self._enviar("/api/detecciones/completar-ocr", {
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
        except Exception as e:
            # El ingreso existe (pendiente de OCR); el personal lo verá para validarlo
            self._log.error("Fallo al completar el OCR del ingreso #%d en el backend: %s", ingreso_id, e)
            self._m.record_detection_error("backend")
            return
        self._tiempos.registrar("registro_http_completar", time.perf_counter() - t_http)
        # El color de la caja en vivo refleja la decisión del backend
        estado_final = None
        try:
            estado_final = (res_ocr.json().get("deteccion") or {}).get("estado_validacion")
            if estado_final and pipeline:
                pipeline.fijar_estado_backend(tracking_id, estado_final)
        except Exception:
            pass
        self._m.record_detection(estado_final or "registrada", str(camara))
        # Latencia del registro: desde la captura del mejor cuadro del paso hasta que el backend
        # confirma la lectura (desde ahí la difunde por Socket.IO)
        hora_cuadro = self._horas_cuadro.get(getattr(candidato, "frame_idx", -1))
        if hora_cuadro and getattr(res_ocr, "status_code", 500) < 300:
            demora = time.time() - hora_cuadro
            self._lat_registro.registrar(demora)
            self._m.record_capture_to_reading("registro", demora)
        self._log.info("CAPTURA REGISTRADA ECU 911 | Ingreso ID #%d | Track #%d | Placa: %s (%.1f%%)", ingreso_id, tracking_id, placa, conf * 100)
        if (pendiente is not None or vehiculo_pendiente is not None) and getattr(res_ocr, "status_code", 500) < 300:
            self._ejecutor_reevaluacion.submit(self._reevaluar, ingreso_id, tracking_id, placa, conf, evidencia,
                                               pendiente or _Pendiente(), vehiculo_pendiente, hora_cuadro)
            return True
        return False
