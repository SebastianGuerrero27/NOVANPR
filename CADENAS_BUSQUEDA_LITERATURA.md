# Cadenas de búsqueda, antecedentes y fundamentos técnicos del sistema ANPR

Documento de apoyo para el apartado **1.2 Antecedentes investigativos** de la tesis «Sistema web
basado en ANPR para el registro de ingreso vehicular en la Coordinación Zonal 3 del Servicio
Integrado de Seguridad ECU 911». Actualizado el 14 de octubre de 2026 para que coincida con el
borrador de la tesis (Anexo A) y con el sistema vigente.

> **Qué cambió respecto a la versión anterior.** La versión anterior describía el pipeline de la
> fase 0 (YOLOv8, EasyOCR/CRNN) y presentaba tres «investigaciones ecuatorianas» (ESPOL, ESPE y
> PUCE/UTA) sin autor ni enlace a un documento concreto, por lo que no podían verificarse; se
> retiraron. Los antecedentes que siguen son los que cita la tesis, con su enlace, y los fundamentos
> técnicos se verificaron contra el registro de DOI (Crossref) o la página oficial de la obra.

## 1. Cadenas de búsqueda de la tesis (Tabla 1 del Anexo A)

Bases consultadas: ScienceDirect, IEEE Xplore, SpringerLink y Google Scholar; período 2021–2026.

| Base de datos | Cadena de búsqueda | Artículos |
|---|---|---:|
| ScienceDirect | `"automatic number plate recognition" OR "license plate recognition" OR "ANPR"` | 64 |
| IEEE Xplore | `("license plate detection" OR "plate localization") AND ("OCR" OR "character recognition")` | 86 |
| SpringerLink | `("real-time video processing" OR "video stream processing") AND ("IP camera" OR "surveillance camera") AND ("vehicle" OR "license plate")` | 116 |
| Google Scholar | `("web-based system" OR "web application") AND ("vehicle access" OR "vehicle registration")` | 42 |
| **Total** | | **308** |

Criterios de inclusión (Tabla 2 del Anexo A): estudios sobre ANPR/LPR; procesamiento de imágenes u
OCR; aplicación a registro de ingreso, seguridad institucional, estacionamientos o monitoreo
vehicular; resultados medibles; publicados entre 2021 y 2026; fuentes académicas confiables.

> Nota de redacción: en la Tabla 1 del Anexo A aparece «carácter recognition»; en inglés es
> «character recognition».

### Cadenas complementarias para las técnicas que usa el sistema actual

Útiles para ampliar la fundamentación teórica (no forman parte de la Tabla 1):

```text
C1 · Detección de placas en una etapa, sin NMS
("license plate detection" OR "ALPR") AND ("YOLO" OR "one-stage detector" OR "NMS-free" OR "end-to-end detection")

C2 · OCR de placas con transformadores compactos
("license plate recognition" OR "text recognition") AND ("compact transformer" OR "CCT" OR "vision transformer")

C3 · Verificación de la lectura y consenso entre cuadros
("license plate recognition") AND ("temporal redundancy" OR "multi-frame" OR "voting" OR "consensus")

C4 · Compuerta de movimiento y sustracción de fondo
("background subtraction" OR "Gaussian mixture model" OR "MOG2") AND ("surveillance" OR "traffic") AND ("real-time")

C5 · Control de acceso vehicular con sistema web
("vehicle access control" OR "gate access") AND ("license plate recognition") AND ("web" OR "database")
```

## 2. Antecedentes seleccionados (los que cita la tesis)

Numeración de la bibliografía del Anexo A.

| Ref. | Trabajo | Aporte para el sistema |
|---|---|---|
| [6] | Lubna, N. Mufti y S. A. A. Shah, «Automatic Number Plate Recognition: A Detailed Survey of Relevant Algorithms», *Sensors*, vol. 21, n.º 9, art. 3028, 2021 | Etapas de un sistema ANPR (adquisición, localización, segmentación y reconocimiento) y factores que afectan su rendimiento |
| [7] | S. Sadiq et al., «Towards Efficient Vehicle Recognition: A Unified System for VMMR, ANPR, and Color Classification», *CMC*, vol. 85, n.º 2, 2025 | Integrar placa, marca, modelo y color; en el sistema, el «segundo factor» (atributos del vehículo con CLIP) |
| [3] | B. Satya et al., «Optimized YOLOv8 for Automatic License Plate Recognition on Resource Constrained Devices», *ETASR*, vol. 15, n.º 2, 2025 | Equilibrio entre precisión, velocidad y recursos; el sistema corre en CPU sin GPU |
| [8] | M. D. González Monard, «Sistema de Monitoreo Visual para el Control de Acceso Vehicular», ESPOL, 2023 | Combina reconocimiento de placas, video, almacenamiento y control de acceso |
| [9] | D. R. Mejía Sandoval, «Sistema de control de acceso vehicular mediante reconocimiento de placas para el personal de la PUCE Sede Ibarra», 2025 | Contexto ecuatoriano de control de acceso institucional |
| [10] | J. M. Alejandro Villacís, «Detección y registro de placas vehiculares aplicando visión por computadora para acceder a las instalaciones universitarias UPSE», 2025 | Sustituir el registro manual en papel por uno digital y consultable |
| [11] | M. L. Acosta Sanjuán et al., «Sistema inteligente de control de acceso vehicular mediante reconocimiento automático de placas para el TecNM Campus Tuxtepec», *Prisma ODS*, 2025 | Control de acceso vehicular institucional |

Los enlaces completos están en la bibliografía del Anexo A.

## 3. Fundamentos técnicos del sistema vigente (verificados)

| Etapa del sistema | Fuente | Verificación |
|---|---|---|
| Revisión del estado del arte de ALPR | S. Du, M. Ibrahim, M. Shehata y W. Badawy, «Automatic License Plate Recognition (ALPR): A State-of-the-Art Review», *IEEE Trans. Circuits Syst. Video Technol.*, vol. 23, n.º 2, pp. 311–325, 2013. doi:10.1109/TCSVT.2012.2203741 | Crossref |
| ALPR con YOLO en tiempo real | R. Laroca et al., «A Robust Real-Time Automatic License Plate Recognition Based on the YOLO Detector», en *IJCNN 2018*, pp. 1–10. doi:10.1109/IJCNN.2018.8489629 | Crossref |
| ALPR independiente del diseño de placa | R. Laroca, L. A. Zanlorensi, G. R. Gonçalves, E. Todt, W. R. Schwartz y D. Menotti, «An efficient and layout-independent automatic license plate recognition system based on the YOLO detector», *IET Intell. Transp. Syst.*, vol. 15, n.º 4, pp. 483–503, 2021. doi:10.1049/itr2.12030 | Crossref |
| Placas en escenarios no controlados | S. M. Silva y C. R. Jung, «License Plate Detection and Recognition in Unconstrained Scenarios», en *ECCV 2018*, LNCS, pp. 593–609. doi:10.1007/978-3-030-01258-8_36 | Crossref |
| Detector de una etapa | J. Redmon, S. Divvala, R. Girshick y A. Farhadi, «You Only Look Once: Unified, Real-Time Object Detection», en *CVPR 2016*, pp. 779–788. doi:10.1109/CVPR.2016.91; versión vigente: Ultralytics YOLO26 [23] | Crossref |
| Conjunto de afinamiento del detector | A. Kuznetsova et al., «The Open Images Dataset V4», *Int. J. Comput. Vis.*, vol. 128, n.º 7, pp. 1956–1981, 2020. doi:10.1007/s11263-020-01316-z | Crossref |
| Seguimiento | Y. Zhang et al., «ByteTrack: Multi-object Tracking by Associating Every Detection Box», en *ECCV 2022*, LNCS, pp. 1–21. doi:10.1007/978-3-031-20047-2_1; R. E. Kalman, «A New Approach to Linear Filtering and Prediction Problems», *J. Basic Eng.*, vol. 82, n.º 1, pp. 35–45, 1960. doi:10.1115/1.3662552 | Crossref |
| Compuerta de movimiento (MOG2) | Z. Zivkovic, «Improved adaptive Gaussian mixture model for background subtraction», en *ICPR 2004*, vol. 2, pp. 28–31. doi:10.1109/ICPR.2004.1333992 | Crossref |
| Nitidez del cuadro | S. Pertuz, D. Puig y M. A. Garcia, «Analysis of focus measure operators for shape-from-focus», *Pattern Recognit.*, vol. 46, n.º 5, pp. 1415–1432, 2013. doi:10.1016/j.patcog.2012.11.011 | Crossref |
| OCR de placas (CCT) | A. Hassani, S. Walton, N. Shah, A. Abuduweili, J. Li y H. Shi, «Escaping the Big Data Paradigm with Compact Transformers», arXiv:2104.05704, 2021; modelos fast-plate-ocr [32] (arquitectura CCT, `cct-s-v2-global-model`) | arXiv y GitHub oficial |
| Verificador de la lectura | Y. Du, C. Li, R. Guo et al., «PP-OCR: A Practical Ultra Lightweight OCR System», arXiv:2009.09941, 2020; C. Cui, T. Sun, M. Lin et al., «PaddleOCR 3.0 Technical Report», arXiv:2507.05595, 2025 (el repositorio oficial anuncia PP-OCRv6 en niveles tiny, small y medium) | arXiv y GitHub oficial |
| Atributos del vehículo | A. Radford, J. W. Kim, C. Hallacy et al., «Learning Transferable Visual Models From Natural Language Supervision», arXiv:2103.00020, 2021 | arXiv |

## 4. Comparación con el estado del arte

| Criterio | Laroca et al. (2018, 2021) | Antecedentes ecuatorianos [8]–[10] | **Este sistema (ECU 911 Zona 3)** |
|---|---|---|---|
| Detección | YOLO | YOLO u OpenCV según el trabajo | **YOLO26n afinado en Open Images V7**, sin NMS, sobre el área de detección |
| Seguimiento | Por cuadro / heurísticas | No central | **Filtro de Kalman y asociación en dos fases (estilo ByteTrack)** |
| Lectura | Red propia con reglas de diseño | OCR de propósito general | **OCR CCT (fast-plate-ocr) + verificador PP-OCRv6 (OpenVINO)**, consenso por pista |
| Validez de la lectura | Heurísticas por diseño de placa | Formato de placa | **Evidencias E1–E5**, interpretación por mínimo de sustituciones y regla «solo placas» |
| Registro | No aplica | Base de datos | **Registro en menos de 1 s** con reevaluación tardía y deduplicación por placa y cámara |
| Decisión de acceso | No aplica | Lista de autorizados | **Lista blanca con vigencia y horario (TRBAC), lista negra que nunca se rebaja, validación por el guardia** |
| Avisos | No aplica | Variable | **Centro de alarmas ISA-18.2** con Socket.IO y Web Push |
| Video | Imágenes / video local | Cámara local | **Cámara IP por RTSP, MediaMTX y WebRTC** con doble flujo |
| Arquitectura | Código de investigación | Aplicación monolítica o cliente-servidor | **Microservicios en contenedores con arquitectura limpia** |

## 5. Guía de uso en las bases de datos

1. **Scopus / Web of Science:** búsqueda avanzada en `TITLE-ABS-KEY`; pegue la cadena.
2. **IEEE Xplore:** *Advanced Search* → *Command Search*; conserve las comillas de los términos compuestos.
3. **Repositorios ecuatorianos (RRAAE, DSpace):** busque «reconocimiento de placas» y filtre por
   trabajos de titulación; registre autor, año y enlace del documento antes de citarlo.
4. **Google Scholar:** use la forma compacta de la cadena y el filtro 2021–presente.
5. Antes de citar, confirme los metadatos en la página del DOI o en <https://api.crossref.org/works/DOI>.
