"""Escena de prueba para la cámara Hikvision simulada (1920×1080, 25 fps).

Cada captura real de un ingreso (con su placa) entra por la izquierda como un vehículo, se detiene
1,6 s (garita) y sale por la derecha, sobre un fondo fijo con ruido de sensor. Se ejecuta dentro
del contenedor del motor (las capturas están en /app/media).
"""
import glob
import sys

import cv2
import numpy as np

ANCHO, ALTO, FPS = 1920, 1080, 25
capturas = sorted(glob.glob("/app/media/ingreso_*.jpg"))
if not capturas:
    sys.exit("sin capturas en /app/media")
elegidas = capturas[4::max(1, len(capturas) // 5)][:4]

fondo = np.full((ALTO, ANCHO, 3), 70, np.uint8)
cv2.rectangle(fondo, (0, int(ALTO * 0.62)), (ANCHO, ALTO), (55, 55, 60), -1)  # calzada
rng = np.random.default_rng(7)
salida = cv2.VideoWriter("/tmp/escena.avi", cv2.VideoWriter_fourcc(*"MJPG"), FPS, (ANCHO, ALTO))
salida.set(cv2.VIDEOWRITER_PROP_QUALITY, 95)


def cuadro(img=None, x=0):
    f = fondo.copy()
    if img is not None:
        h, w = img.shape[:2]
        y = (ALTO - h) // 2
        x0, x1 = max(0, x), min(ANCHO, x + w)
        if x1 > x0:
            f[y:y + h, x0:x1] = img[:, x0 - x:x1 - x]
    ruido = rng.normal(0, 2, f.shape)
    salida.write(np.clip(f.astype(np.float32) + ruido, 0, 255).astype(np.uint8))


total = 0
for ruta in elegidas:
    img = cv2.imread(ruta)
    escala = min(ANCHO * 0.62 / img.shape[1], ALTO * 0.9 / img.shape[0])
    img = cv2.resize(img, None, fx=escala, fy=escala, interpolation=cv2.INTER_AREA)
    centro = (ANCHO - img.shape[1]) // 2
    for _ in range(int(0.8 * FPS)):
        cuadro()
        total += 1
    entra, quieto, sale = int(1.2 * FPS), int(1.6 * FPS), int(1.0 * FPS)
    for i in range(entra):
        cuadro(img, int(-img.shape[1] + (centro + img.shape[1]) * (i + 1) / entra))
        total += 1
    for _ in range(quieto):
        cuadro(img, centro)
        total += 1
    for i in range(sale):
        cuadro(img, int(centro + (ANCHO - centro) * (i + 1) / sale))
        total += 1
salida.release()
print(f"{total} cuadros ({total / FPS:.1f} s) con {len(elegidas)} capturas: {[r.rsplit('/', 1)[-1] for r in elegidas]}")
