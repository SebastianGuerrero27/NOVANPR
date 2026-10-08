"""
Verificación geométrica de placas (inspirada en OpenALPR).

OpenALPR (https://github.com/openalpr/openalpr) no confía en el detector: cada región
candidata pasa por un análisis de caracteres (`CharacterAnalysis`: umbralizaciones
múltiples, componentes conexas y búsqueda de una fila de caracteres de altura similar) y
por la búsqueda de los bordes de la placa (`PlateLines` / `PlateCorners`) antes del OCR.
Solo las regiones que contienen una fila de caracteres plausible se consideran placas y se
dibujan con un cuadrilátero ajustado a la inclinación real.

Este módulo implementa esas ideas de forma liviana (OpenCV, ≈ 5 ms por recorte en
CPU) para:
  1. `analizar_caracteres`: decidir si un recorte contiene la fila de caracteres de una
     placa ecuatoriana (5–9 caracteres alineados, de altura consistente) y ubicarla.
  2. `cuadrilatero_placa`: estimar las 4 esquinas de la placa a partir de esa fila y de la
     geometría ANT (placa de 404 × 154 mm con la franja "ECUADOR" arriba).
  3. `toca_borde`: detectar placas cortadas por el borde del cuadro (lectura truncada).
  4. `evaluar_lectura`: combinar formato, geometría, consenso multi-cuadro y concordancia
     con el segundo OCR en un veredicto "lectura válida" con sus evidencias.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

import cv2
import numpy as np

# Geometría de la placa ANT (auto): la fila de caracteres ocupa ~47 % del alto de la placa,
# con la franja "ECUADOR" por encima; la placa mide ~2,6 veces su alto.
_REL_ALTO_CARACTER = 0.47
_ARRIBA_DE_FILA = 0.70     # alto de caracter que hay entre el borde superior y la fila
_ABAJO_DE_FILA = 0.43      # alto de caracter entre la fila y el borde inferior
_ASPECTO_PLACA = 2.62

MIN_CARACTERES = 5
MAX_CARACTERES = 9


@dataclass
class AnalisisCaracteres:
    caracteres: int = 0
    altura: float = 0.0                     # alto medio de caracter (px del recorte)
    banda: Optional[list[int]] = None       # [x1, y1, x2, y2] de la fila en el recorte
    angulo: float = 0.0                     # inclinación de la fila (grados)
    puntaje: float = 0.0                    # 0–1: regularidad de alturas y alineación
    valida: bool = False
    cajas: list[list[int]] = field(default_factory=list)
    centro: Optional[list[float]] = None    # centro de la fila en el recorte (px)
    ancho_fila: float = 0.0                 # largo de la fila a lo largo de su inclinación (px)
    contorno: Optional[list[list[float]]] = None  # esquinas de la placa en el recorte (PlateLines)
    bordes_hallados: int = 0                # cuántos de los 4 bordes se hallaron en la imagen


def _componentes(binaria: np.ndarray, alto: int, ancho: int) -> list[tuple[int, int, int, int]]:
    """
    Componentes conexas con forma y tamaño de caracter principal. La altura mínima se
    fija respecto del ANCHO del recorte (≈ ancho de la placa): en una placa ANT los
    caracteres principales miden ~18 % del ancho y las letras de la franja "ECUADOR"
    ~5 %, así que la franja nunca se confunde con la fila de la placa.
    """
    # `alto` y `ancho` son los del recorte normalizado original: al enderezar, la imagen
    # rotada es más grande pero los caracteres conservan su tamaño.
    alto_img = binaria.shape[0]
    n, _, stats, _ = cv2.connectedComponentsWithStats(binaria, connectivity=8)
    cajas = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (max(0.16 * alto, 0.10 * ancho) <= h <= 0.92 * alto):
            continue
        if not (0.08 * h <= w <= 1.1 * h):
            continue
        relleno = area / float(max(1, w * h))
        if not (0.12 <= relleno <= 0.95):
            continue
        # Un caracter completo no toca el borde superior ni inferior del recorte
        if y <= 0 or y + h >= alto_img:
            continue
        cajas.append((int(x), int(y), int(w), int(h)))
    return cajas


def _mejor_fila(cajas: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """
    Grupo más grande de cajas con altura similar y centros alineados sobre una recta
    (equivalente simplificado a la búsqueda de "text line" de OpenALPR). Con la placa en
    perspectiva los caracteres del lado cercano son más altos: la altura esperada se
    interpola linealmente entre las dos cajas semilla en lugar de exigir una constante.
    """
    if len(cajas) < 2:
        return list(cajas)
    mejor: list[tuple[int, int, int, int]] = []
    ordenadas = sorted(cajas, key=lambda c: c[0])
    for i, a in enumerate(ordenadas):
        for b in ordenadas[i + 1:]:
            ha, hb = a[3], b[3]
            if abs(ha - hb) > 0.35 * max(ha, hb):
                continue
            ax, ay = a[0] + a[2] / 2, a[1] + a[3] / 2
            bx, by = b[0] + b[2] / 2, b[1] + b[3] / 2
            if bx - ax < 1:
                continue
            pendiente = (by - ay) / (bx - ax)
            if abs(pendiente) > 0.6:  # > ~31°: no es una fila de placa
                continue
            grad_h = (hb - ha) / (bx - ax)
            grupo = []
            for c in ordenadas:
                cx, cy = c[0] + c[2] / 2, c[1] + c[3] / 2
                h_ref = max(1.0, ha + grad_h * (cx - ax))
                esperado = ay + pendiente * (cx - ax)
                if abs(cy - esperado) <= 0.22 * h_ref and abs(c[3] - h_ref) <= 0.22 * h_ref:
                    grupo.append(c)
            if len(grupo) > len(mejor):
                mejor = grupo
    return mejor


def _normalizar(gris: np.ndarray) -> tuple[np.ndarray, float]:
    """Escala el recorte a 96 px de alto (escala en la que se calibraron los umbrales) y aplica CLAHE."""
    escala = 96.0 / gris.shape[0]
    g = cv2.resize(gris, (max(8, int(gris.shape[1] * escala)), 96), interpolation=cv2.INTER_AREA if escala < 1 else cv2.INTER_CUBIC)
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4)).apply(g), escala


def _buscar_fila(gris: np.ndarray, alto_ref: int, ancho_ref: int) -> list[tuple[int, int, int, int]]:
    """Mejor fila de caracteres entre varias binarizaciones (idea de CharacterAnalysis de OpenALPR)."""
    binarizaciones = [
        cv2.adaptiveThreshold(gris, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, bloque, 9)
        for bloque in (19, 31)
    ]
    _, otsu = cv2.threshold(gris, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    binarizaciones.append(otsu)
    # Placas con fondo oscuro (poco frecuentes): polaridad inversa
    binarizaciones.append(cv2.adaptiveThreshold(gris, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 9))

    # Además de la limpieza mínima, una apertura más fuerte separa los caracteres que quedan
    # unidos al marco de la placa o entre sí por trazos delgados (placas inclinadas o de
    # baja resolución); OpenALPR resuelve lo mismo eliminando los bordes de la placa.
    nucleos = (np.ones((2, 2), np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    mejor: list[tuple[int, int, int, int]] = []
    for b in binarizaciones:
        for k in nucleos:
            fila = _mejor_fila(_componentes(cv2.morphologyEx(b, cv2.MORPH_OPEN, k), alto_ref, ancho_ref))
            if len(fila) > len(mejor):
                mejor = fila
        if len(mejor) >= 7:
            break
    return mejor


def _pendiente(fila: list[tuple[int, int, int, int]]) -> float:
    centros = np.array([[c[0] + c[2] / 2, c[1] + c[3] / 2] for c in fila], dtype=float)
    return float(np.polyfit(centros[:, 0], centros[:, 1], 1)[0]) if len(fila) >= 2 else 0.0


def _ordenar_esquinas(pts: np.ndarray) -> np.ndarray:
    """Superior izquierda, superior derecha, inferior derecha, inferior izquierda."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def _interseccion(p1: np.ndarray, d1: np.ndarray, p2: np.ndarray, d2: np.ndarray) -> Optional[np.ndarray]:
    """Intersección de dos rectas dadas por punto y dirección."""
    m = np.array([[d1[0], -d2[0]], [d1[1], -d2[1]]], dtype=float)
    if abs(np.linalg.det(m)) < 1e-6:
        return None
    t = np.linalg.solve(m, (p2 - p1).astype(float))
    return p1 + t[0] * d1


def _bordes_placa(gris: np.ndarray, centro: tuple[float, float], hc: float, largo_fila: float,
                  angulo: float) -> tuple[list[list[float]], int]:
    """
    Bordes de la placa al estilo PlateLines/PlateCorners de OpenALPR: rectas de Hough sobre
    el mapa de bordes, eligiendo
      - superior e inferior: casi paralelas a la fila de caracteres y a la distancia que
        predice la geometría ANT (franja "ECUADOR" arriba, margen menor abajo);
      - izquierda y derecha: casi perpendiculares, justo fuera de los extremos de la fila.
    Cada borde que no se encuentra se sustituye por el del modelo geométrico, de modo que
    siempre se devuelve un cuadrilátero; el segundo valor es cuántos bordes reales (0–4)
    lo sustentan. Esquinas en orden: sup. izq., sup. der., inf. der., inf. izq.
    """
    c = np.array(centro, dtype=float)
    a = np.radians(angulo)
    u = np.array([np.cos(a), np.sin(a)])          # dirección de la fila
    v = np.array([-np.sin(a), np.cos(a)])         # perpendicular, hacia abajo
    e_sup = (0.5 + _ARRIBA_DE_FILA) * hc           # distancia esperada centro de fila -> borde superior
    e_inf = (0.5 + _ABAJO_DE_FILA) * hc
    e_lat = largo_fila / 0.90 / 2                  # medio ancho esperado de la placa

    sup = inf = izq = der = None
    try:
        suave = cv2.GaussianBlur(gris, (5, 5), 0)
        med = float(np.median(suave))
        bordes = cv2.Canny(suave, int(max(10, 0.66 * med)), int(min(255, max(40, 1.33 * med))))
        segmentos = cv2.HoughLinesP(bordes, 1, np.pi / 180, threshold=max(15, int(0.5 * hc)),
                                    minLineLength=max(8, int(0.5 * hc)), maxLineGap=max(3, int(0.06 * largo_fila)))
    except cv2.error:
        segmentos = None

    mejor = {"sup": (-1e9, None), "inf": (-1e9, None), "izq": (-1e9, None), "der": (-1e9, None)}
    for x1, y1, x2, y2 in (segmentos.reshape(-1, 4) if segmentos is not None else []):
        p = np.array([x1, y1], dtype=float)
        d = np.array([x2 - x1, y2 - y1], dtype=float)
        largo = float(np.hypot(*d))
        if largo < 1:
            continue
        d /= largo
        if d @ u < 0:
            d = -d
        coseno = abs(float(d @ u))
        medio = (p + np.array([x2, y2])) / 2 - c
        if coseno >= np.cos(np.radians(14)):
            # Candidato horizontal: distancia (con signo) a la fila y longitud relativa
            if largo < 0.35 * largo_fila:
                continue
            dist = float(medio @ v)
            clave, esperado = ("sup", e_sup) if dist < 0 else ("inf", e_inf)
            rel = abs(dist) / esperado
            if not (0.65 <= rel <= 1.6):
                continue
            puntaje = largo / largo_fila - 1.2 * abs(rel - 1.0)
        elif coseno <= np.cos(np.radians(55)):
            # Candidato vertical: fuera de la fila y cerca del ancho esperado de la placa
            if largo < 0.6 * hc or abs(float(medio @ v)) > 1.5 * hc:
                continue
            dist = float(medio @ u)
            clave = "izq" if dist < 0 else "der"
            rel = abs(dist) / e_lat
            if not (0.85 <= rel <= 1.3) or abs(dist) < largo_fila / 2:
                continue
            puntaje = largo / hc - 3.0 * abs(rel - 1.0)
        else:
            continue
        if puntaje > mejor[clave][0]:
            mejor[clave] = (puntaje, (p, d))

    # Bordes opuestos casi paralelos (la perspectiva los separa pocos grados): si no lo son,
    # uno de los dos pertenece a otro objeto y se descarta el de menor puntaje.
    # (los laterales toleran más: con la placa girada respecto de la cámara convergen hacia
    # el punto de fuga).
    for k1, k2, tolerancia in (("sup", "inf", 18), ("izq", "der", 32)):
        if mejor[k1][1] is not None and mejor[k2][1] is not None:
            if abs(float(mejor[k1][1][1] @ mejor[k2][1][1])) < np.cos(np.radians(tolerancia)):
                peor = k1 if mejor[k1][0] < mejor[k2][0] else k2
                mejor[peor] = (-1e9, None)
    halladas = sum(1 for k in mejor if mejor[k][1] is not None)
    sup = mejor["sup"][1] or (c - e_sup * v, u)
    inf = mejor["inf"][1] or (c + e_inf * v, u)
    # Sin bordes laterales: se usa la dirección de los laterales hallados o la perpendicular
    # al promedio de los bordes superior e inferior.
    lateral = (mejor["izq"][1] or mejor["der"][1] or (None, None))[1]
    if lateral is None:
        media = sup[1] + inf[1]
        lateral = np.array([-media[1], media[0]]) / max(1e-6, float(np.hypot(*media)))
    izq = mejor["izq"][1] or (c - e_lat * u, lateral)
    der = mejor["der"][1] or (c + e_lat * u, lateral)
    esquinas = [_interseccion(*sup, *izq), _interseccion(*sup, *der), _interseccion(*inf, *der), _interseccion(*inf, *izq)]
    if any(e is None for e in esquinas):
        # Rectas degeneradas: modelo geométrico puro
        esquinas = [c - e_lat * u - e_sup * v, c + e_lat * u - e_sup * v, c + e_lat * u + e_inf * v, c - e_lat * u + e_inf * v]
        halladas = 0
    return [[float(e[0]), float(e[1])] for e in esquinas], halladas


def analizar_caracteres(recorte: np.ndarray, min_caracteres: int = MIN_CARACTERES) -> AnalisisCaracteres:
    """
    Busca la fila de caracteres de la placa probando varias binarizaciones y, si la fila
    está inclinada, endereza el recorte y repite la búsqueda (deskew de OpenALPR).
    `min_caracteres` baja a 2 para placas de motocicleta (cuadradas, en dos filas).
    """
    if recorte is None or recorte.size == 0 or min(recorte.shape[:2]) < 8:
        return AnalisisCaracteres()
    gris0 = cv2.cvtColor(recorte, cv2.COLOR_BGR2GRAY) if recorte.ndim == 3 else recorte
    gris, escala = _normalizar(gris0)
    alto_ref, ancho_ref = gris.shape[:2]
    fila = _buscar_fila(gris, alto_ref, ancho_ref)
    inversa = None      # transformación del espacio enderezado al recorte normalizado
    angulo_base = 0.0

    # Enderezado: con inclinación fuerte los caracteres rotados se funden entre sí o con el
    # marco; rotar el recorte para dejar la fila horizontal los vuelve a separar.
    if 2 <= len(fila) < 6:
        ang = float(np.degrees(np.arctan(_pendiente(fila))))
        if abs(ang) >= 6.0:
            cx, cy = ancho_ref / 2, alto_ref / 2
            m = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
            cos, sen = abs(m[0, 0]), abs(m[0, 1])
            nw, nh = int(ancho_ref * cos + alto_ref * sen), int(alto_ref * cos + ancho_ref * sen)
            m[0, 2] += nw / 2 - cx
            m[1, 2] += nh / 2 - cy
            rotada = cv2.warpAffine(gris, m, (nw, nh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            fila_rot = _buscar_fila(rotada, alto_ref, ancho_ref)
            if len(fila_rot) > len(fila):
                fila, inversa, angulo_base = fila_rot, cv2.invertAffineTransform(m), ang

    n = len(fila)
    if n < 2:
        return AnalisisCaracteres(caracteres=n)
    if n > MAX_CARACTERES:
        # Más "caracteres" que una placa: textura (rejillas, rótulos). Se conservan los
        # más altos para ubicar la fila, pero no cuenta como placa.
        fila = sorted(fila, key=lambda c: -c[3])[:MAX_CARACTERES + 1]

    alturas = np.array([c[3] for c in fila], dtype=float)
    centros = np.array([[c[0] + c[2] / 2, c[1] + c[3] / 2] for c in fila], dtype=float)
    ajuste = np.polyfit(centros[:, 0], centros[:, 1], 1)
    residuo = float(np.std(centros[:, 1] - np.polyval(ajuste, centros[:, 0])))
    regularidad = max(0.0, 1.0 - float(np.std(alturas) / max(1.0, alturas.mean())) * 3)
    alineacion = max(0.0, 1.0 - residuo / max(1.0, alturas.mean()) * 4)
    x1, x2 = min(c[0] for c in fila), max(c[0] + c[2] for c in fila)
    y1, y2 = min(c[1] for c in fila), max(c[1] + c[3] for c in fila)
    centro = np.array([(x1 + x2) / 2, (y1 + y2) / 2])
    if inversa is not None:
        centro = inversa[:, :2] @ centro + inversa[:, 2]
        centros = centros @ inversa[:, :2].T + inversa[:, 2]
    angulo = angulo_base + float(np.degrees(np.arctan(ajuste[0])))
    inv = 1.0 / escala
    cx, cy = centro * inv
    hc = float(alturas.mean() * inv)
    ancho_fila = float((x2 - x1) * inv)
    # Caja de la fila en el recorte (eje alineado) y cajas de cada caracter
    dx = ancho_fila * abs(np.cos(np.radians(angulo))) / 2
    dy = ancho_fila * abs(np.sin(np.radians(angulo))) / 2 + hc / 2
    cajas = [[int(px * inv - c[2] * inv / 2), int(py * inv - c[3] * inv / 2), int(c[2] * inv), int(c[3] * inv)]
             for (px, py), c in zip(centros, fila)]
    valida = min_caracteres <= n <= MAX_CARACTERES
    contorno, bordes = (None, 0)
    if valida and min_caracteres >= MIN_CARACTERES:
        contorno, bordes = _bordes_placa(gris0, (cx, cy), hc, ancho_fila, angulo)
    return AnalisisCaracteres(
        caracteres=n,
        altura=hc,
        banda=[int(cx - dx), int(cy - dy), int(cx + dx), int(cy + dy)],
        angulo=angulo,
        puntaje=round((regularidad + alineacion) / 2, 3),
        valida=valida,
        cajas=cajas,
        centro=[float(cx), float(cy)],
        ancho_fila=ancho_fila,
        contorno=contorno,
        bordes_hallados=bordes,
    )


def cuadrilatero_placa(bbox: list[int], analisis: AnalisisCaracteres, ancho_img: int, alto_img: int,
                       origen: tuple[int, int] = (0, 0)) -> Optional[list[list[int]]]:
    """
    Cuatro esquinas de la placa (superior izquierda, superior derecha, inferior derecha,
    inferior izquierda) en coordenadas de la imagen, a partir de los bordes hallados por
    `_bordes_placa`. `origen` es la posición del recorte analizado dentro de la imagen.
    Devuelve None si no hay fila válida o si el resultado no tiene forma de placa.
    """
    if not analisis.valida or not analisis.contorno:
        return None
    ox, oy = origen
    x1, y1, x2, y2 = bbox
    pts = np.array(analisis.contorno, dtype=float) + [ox, oy]
    # Coherencia: proporción de placa (con perspectiva) y sin desbordar demasiado la caja del detector
    ancho = (np.linalg.norm(pts[1] - pts[0]) + np.linalg.norm(pts[2] - pts[3])) / 2
    alto = (np.linalg.norm(pts[3] - pts[0]) + np.linalg.norm(pts[2] - pts[1])) / 2
    if not (1.4 <= ancho / max(1.0, alto) <= 4.8):
        return None
    mx, my = 0.12 * (x2 - x1), 0.20 * (y2 - y1)
    pts[:, 0] = np.clip(pts[:, 0], max(0, x1 - mx), min(ancho_img - 1, x2 + mx))
    pts[:, 1] = np.clip(pts[:, 1], max(0, y1 - my), min(alto_img - 1, y2 + my))
    return [[int(round(px)), int(round(py))] for px, py in pts]


def toca_borde(bbox: list[int], ancho_img: int, alto_img: int, margen_rel: float = 0.01) -> bool:
    """True si la placa está cortada por el borde del cuadro (lectura potencialmente truncada)."""
    x1, y1, x2, y2 = bbox
    mx, my = max(2, int(ancho_img * margen_rel)), max(2, int(alto_img * margen_rel))
    return x1 <= mx or y1 <= my or x2 >= ancho_img - mx or y2 >= alto_img - my


def toca_borde_lateral(bbox: list[int], ancho_img: int, margen_rel: float = 0.02) -> bool:
    """
    True si la placa puede estar cortada por el borde izquierdo o derecho del cuadro. En una placa
    horizontal la fila de caracteres ocupa casi todo el ancho, así que ese corte quita caracteres
    enteros ("SY589" por "PSY589"); un corte arriba o abajo quita primero la franja "ECUADOR" o
    el margen inferior. El margen (2 % del ancho) cubre la holgura del detector, que al entrar la
    placa puede dibujar la caja unos píxeles adentro aunque la placa siga cortada.
    """
    x1, _, x2, _ = bbox
    mx = max(2, int(ancho_img * margen_rel))
    return x1 <= mx or x2 >= ancho_img - mx


def recorte_con_margen(frame: np.ndarray, bbox: list[int], mx: float = 0.08, my: float = 0.12) -> tuple[np.ndarray, tuple[int, int]]:
    """Recorte de la caja con un margen (para que los caracteres no toquen el borde)."""
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = bbox
    px, py = int((x2 - x1) * mx), int((y2 - y1) * my)
    a, b = max(0, x1 - px), max(0, y1 - py)
    return frame[b:min(h, y2 + py), a:min(w, x2 + px)], (a, b)


def punto_en_roi(x: float, y: float, roi_px: Optional[np.ndarray]) -> bool:
    """True si el punto está dentro del polígono de la región de interés (o no hay región)."""
    if roi_px is None or len(roi_px) < 3:
        return True
    return cv2.pointPolygonTest(roi_px, (float(x), float(y)), False) >= 0


@dataclass
class ValidezLectura:
    valido: bool
    formato: bool
    dentro_cuadro: bool
    caracteres: int
    lecturas: int
    verificador_coincide: bool
    motivos: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


def evaluar_lectura(*, formato_valido: bool, bbox: list[int], ancho_img: int, alto_img: int,
                    analisis: AnalisisCaracteres, lecturas_concordantes: int, verificador_coincide: bool,
                    min_lecturas: int = 2) -> ValidezLectura:
    """
    Una lectura es VÁLIDA (y el sistema puede decidir sin intervención) cuando se cumplen
    todas las evidencias independientes:
      1. Formato oficial ANT.
      2. Placa completa dentro del cuadro (no truncada por el borde).
      3. Fila de caracteres plausible en el recorte (análisis de caracteres).
      4. Confirmación: la misma placa leída en ≥ `min_lecturas` cuadros del track, o
         coincidencia exacta con el segundo OCR (PP-OCRv6).
    """
    dentro = not toca_borde(bbox, ancho_img, alto_img)
    motivos = []
    if not formato_valido:
        motivos.append('formato ANT no válido')
    if not dentro:
        motivos.append('placa cortada por el borde del cuadro')
    # Con inclinación fuerte los caracteres se funden con el marco y el análisis geométrico
    # falla aunque la lectura sea correcta: un consenso fuerte (≥ 3 cuadros y ambos OCR de
    # acuerdo) sustituye a la evidencia geométrica.
    consenso_fuerte = lecturas_concordantes >= 3 and verificador_coincide
    if not analisis.valida and not consenso_fuerte:
        motivos.append(f'fila de caracteres no confirmada ({analisis.caracteres} caracteres)')
    confirmada = lecturas_concordantes >= min_lecturas or verificador_coincide
    if not confirmada:
        motivos.append('una sola lectura sin confirmación del segundo OCR')
    return ValidezLectura(
        valido=not motivos, formato=formato_valido, dentro_cuadro=dentro, caracteres=analisis.caracteres,
        lecturas=lecturas_concordantes, verificador_coincide=verificador_coincide, motivos=motivos,
    )
