"""
Script de Demostración y Validación del LicensePlatePipeline Industrial.
Carga una imagen de prueba, ejecuta el pipeline completo y guarda el frame anotado.
"""

from __future__ import annotations

import os
import sys
import time
import cv2
import numpy as np

# Asegurar path de imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.config_schemas import RunConfig
from app.core.license_plate_pipeline import LicensePlatePipeline
from app.utils.logger import get_logger

logger = get_logger("demo_pipeline")


def run_demo():
    sample_paths = [
        "v_full.jpg",
        "video_exact.jpg",
        "crop_test.jpg",
        "plate_sample.jpg",
    ]

    sample_img_path = None
    for p in sample_paths:
        if os.path.exists(p):
            sample_img_path = p
            break

    if not sample_img_path:
        # Crear frame sintético si no hay imágenes
        frame = np.full((720, 1280, 3), 45, dtype=np.uint8)
        # Dibujar un auto sintético
        cv2.rectangle(frame, (300, 200), (980, 600), (80, 90, 100), -1)
        # Dibujar matrícula sintética
        cv2.rectangle(frame, (540, 480), (740, 540), (240, 240, 240), -1)
        cv2.putText(frame, "PBX-1234", (560, 520), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (10, 10, 10), 3)
        sample_img_path = "media/demo_synthetic.jpg"
        os.makedirs("media", exist_ok=True)
        cv2.imwrite(sample_img_path, frame)
        logger.info("Imagen sintética generada en: %s", sample_img_path)
    else:
        frame = cv2.imread(sample_img_path)

    # Configuración de ejecución
    config_dict = {
        "model": "yolo11n.pt" if os.path.exists("yolo11n.pt") else "models/license_plate_detector.pt",
        "confidence": 0.30,
        "device": "cpu",
        "imgsz": 640,
        "alpr": {
            "mode": "full",
            "ocr_cache": "once",
            "plate_scope": "vehicle",
            "plate_model": "models/license_plate_detector.pt" if os.path.exists("models/license_plate_detector.pt") else "yolo11n.pt",
            "ocr_engine": "paddle",
            "ocr_confidence": 0.25,
            "show_detection_zone": True,
            "detection_zone": [[50, 50], [1230, 50], [1230, 670], [50, 670]],
            "hud": {
                "panel_x": 20,
                "panel_y": 90,
                "panel_width": 360,
                "title": "ECU 911 — CONTROL VEHICULAR",
                "max_cards": 5,
            },
        },
    }

    run_config = RunConfig.from_dict(config_dict)
    logger.info("Construyendo LicensePlatePipeline desde RunConfig...")

    # Instanciación
    try:
        pipeline = LicensePlatePipeline.from_config(run_config)
    except Exception as e:
        logger.warning("No se pudieron cargar modelos reales de YOLO (%s). Utilizando MockDetector para demo.", e)
        from app.core.detectors import MockDetector
        from app.core.ocr_backends import MockOCREngine
        from app.core.trackers import TeachingTracker
        from app.core.models import Detection

        h, w = frame.shape[:2]
        veh_det = MockDetector([Detection(bbox=[int(w*0.2), int(h*0.2), int(w*0.8), int(h*0.8)], confidence=0.92, class_name="car")])
        plate_det = MockDetector([Detection(bbox=[int(w*0.4), int(h*0.6), int(w*0.6), int(h*0.7)], confidence=0.89, class_name="plate")])
        tracker = TeachingTracker(min_hits=1)
        ocr_engine = MockOCREngine(return_text="PBX-1234", return_confidence=0.97)

        pipeline = LicensePlatePipeline(
            vehicle_detector=veh_det,
            plate_detector=plate_det,
            tracker=tracker,
            ocr_backend=ocr_engine,
            mode="full",
            detection_zone=[(20, 20), (w - 20, 20), (w - 20, h - 20), (20, h - 20)],
        )

    # Procesar fotograma
    logger.info("Procesando frame...")
    result = pipeline.process_frame(frame)

    output_path = "media/demo_result.jpg"
    os.makedirs("media", exist_ok=True)
    cv2.imwrite(output_path, result.annotated_frame)

    print("\n" + "=" * 60)
    print("DEMOSTRACIÓN DE PIPELINE ANPR COMPLETADA EXITOSAMENTE")
    print("=" * 60)
    print(f"Latencia total: {result.latency_ms:.2f} ms ({result.fps:.1f} FPS)")
    print(f"Vehículos detectados: {len(result.vehicles)}")
    print(f"Tracks activos: {len(result.tracks)}")
    print(f"Lecturas OCR generadas: {len(result.readings)}")
    for r in result.readings:
        print(f"  -> Placa: {r.text} | Confianza: {r.confidence:.1%} | Provincia: {r.province} | Válida: {r.is_valid}")
    print(f"Imagen anotada guardada en: {os.path.abspath(output_path)}")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    run_demo()
