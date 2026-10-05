"""Pruebas de la rectificación por esquinas y de la ubicación del vehículo que contiene la placa."""

import numpy as np

from app.infraestructura.plate_rectifier import PLATE_ASPECT, is_valid_quad, order_corners, warp_to_plate
from app.infraestructura.vehicle_attributes import estimated_vehicle_box, vehicle_box_for_plate


def test_order_corners_desde_cualquier_orden():
    pts = np.float32([[90, 40], [10, 10], [10, 40], [90, 12]])  # desordenados
    tl, tr, br, bl = order_corners(pts)
    assert tuple(tl) == (10, 10) and tuple(tr) == (90, 12) and tuple(br) == (90, 40) and tuple(bl) == (10, 40)


def test_quad_valido_e_invalido():
    quad = np.float32([[10, 10], [90, 12], [90, 40], [10, 40]])
    assert is_valid_quad(quad, (50, 100))
    cruzado = np.float32([[10, 10], [90, 40], [90, 12], [10, 40]])   # "moño": no convexo
    assert not is_valid_quad(cruzado, (50, 100))
    diminuto = np.float32([[10, 10], [12, 10], [12, 11], [10, 11]])
    assert not is_valid_quad(diminuto, (50, 100))


def test_warp_produce_proporcion_ant():
    crop = np.random.randint(0, 255, (60, 200, 3), np.uint8)
    out = warp_to_plate(crop, np.float32([[20, 5], [180, 10], [175, 55], [25, 50]]))
    h, w = out.shape[:2]
    assert abs(w / h - PLATE_ASPECT) < 0.05


def test_vehiculo_que_contiene_la_placa():
    boxes = [([0, 0, 1000, 800], 2, 0.9), ([300, 200, 700, 600], 2, 0.8), ([800, 100, 900, 200], 7, 0.7)]
    box, cls = vehicle_box_for_plate(boxes, [450, 500, 550, 540])
    assert box == [300, 200, 700, 600]      # la caja contenedora más pequeña
    assert vehicle_box_for_plate(boxes, [950, 900, 990, 950]) is None


def test_caja_estimada_dentro_de_la_imagen():
    x1, y1, x2, y2 = estimated_vehicle_box([100, 400, 200, 440], (480, 640, 3))
    assert 0 <= x1 < 100 and 0 <= y1 < 400 and 200 < x2 <= 640 and 440 < y2 <= 480
