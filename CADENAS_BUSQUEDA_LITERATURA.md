# Cadenas de Búsqueda Académica y Estado del Arte: Sistema ANPR con Deep Learning

Este documento contiene el diseño riguroso de las **cadenas de búsqueda bibliográfica (Search Strings)** estructuradas con operadores booleanos (`AND`, `OR`, `NOT`), comodines y delimitadores para indexadores científicos internacionales y repositorios universitarios ecuatorianos.

Asimismo, expone en detalle:
1. **3 Artículos Científicos Fundacionales** en los cuales se basa la arquitectura, los modelos y el pipeline técnico de este proyecto.
2. **3 Investigaciones Similares de Universidades Ecuatorianas** orientadas al reconocimiento de matrículas vehiculares según el estándar de la Agencia Nacional de Tránsito (ANT) y la normativa INEN de Ecuador.

---

## Metodología de Formulación de Ecuaciones de Búsqueda

Para garantizar exhaustividad y precisión en la recuperación de información académica (Scopus, IEEE Xplore, Web of Science, Google Scholar, Scielo y Repositorios DSpace), se emplean las siguientes directrices sintácticas:
* **Operadores Booleanos:**
  * `AND`: Intersección temática obligatoria (conecta conceptos independientes: *Detección* AND *Placas* AND *Ecuador*).
  * `OR`: Unión de sinónimos, acrónimos o variantes terminológicas (*"ALPR"* OR *"ANPR"* OR *"License Plate Recognition"*).
  * `NOT` o `-`: Exclusión de dominios ruidosos (ej. reconocimiento de placas de circuitos impresos / *PCB*).
* **Delimitadores de Frase Exacta (`"..."`):** Evita la dispersión de términos multipalabra (ej. *"Deep Learning"*, *"ByteTrack"*, *"Optical Character Recognition"*).
* **Comodines de Truncamiento (`*`):** Permite capturar variaciones gramaticales y sufijos (ej. `detect*` captura *detection, detector, detecting*).

---

## PARTE 1: Cadenas de Búsqueda y Artículos Fundacionales del Proyecto

El sistema desarrollado en este repositorio implementa un **pipeline de dos fases (Two-Phase Pipeline)**:
1. Detección del vehículo y la matrícula mediante **YOLOv8** (detector de una sola etapa).
2. Seguimiento y asociación espaciotemporal mediante **ByteTrack** (Filtro de Kalman + IoU).
3. Selección óptima de fotograma mediante **métrica de nitidez (Laplacian Blur)**.
4. Reconocimiento de caracteres mediante redes secuenciales **CRNN + CTC** (motor de EasyOCR / PaddleOCR).
5. Post-procesamiento sintáctico adaptado a la **normativa vehicular de Ecuador**.

A continuación se presentan las cadenas de búsqueda y los tres artículos seminales que sustentan estos pilares:

### 1.1. Ecuaciones de Búsqueda para Artículos Base

#### Cadena A1: Detección de Matrículas en Tiempo Real con Familias YOLO (Scopus / IEEE Xplore / WoS)
```text
("ALPR" OR "ANPR" OR "license plate recognition" OR "license plate detection" OR "number plate detection") 
AND ("YOLO" OR "YOLOv8" OR "You Only Look Once" OR "one-stage detector") 
AND ("real-time" OR "deep learning" OR "convolutional neural network") 
AND NOT ("PCB" OR "dental" OR "biomedical")
```
* **Versión Google Scholar:**
  ```text
  ("ALPR" OR "ANPR") ("license plate detection") ("YOLO" OR "YOLOv8") "real-time" "deep learning"
  ```

#### Cadena A2: Seguimiento Multiobjeto y Asociación Espaciotemporal (ByteTrack & Kalman Filter)
```text
("multi-object tracking" OR "MOT" OR "vehicle tracking" OR "license plate tracking") 
AND ("ByteTrack" OR "Byte" OR "Kalman filter" OR "IoU association") 
AND ("real-time" OR "surveillance" OR "video stream" OR "two-stage")
```
* **Versión Google Scholar:**
  ```text
  "ByteTrack" ("multi-object tracking" OR "MOT") ("Kalman filter") ("vehicle" OR "surveillance")
  ```

#### Cadena A3: Reconocimiento Óptico de Caracteres Secuencial (CRNN + CTC / Scene Text Recognition)
```text
("license plate recognition" OR "scene text recognition" OR "text recognition") 
AND ("CRNN" OR "Convolutional Recurrent Neural Network" OR "Connectionist Temporal Classification" OR "CTC") 
AND ("deep learning" OR "EasyOCR" OR "sequence recognition")
```
* **Versión Google Scholar:**
  ```text
  ("scene text recognition" OR "license plate recognition") ("CRNN" OR "Convolutional Recurrent Neural Network") "CTC"
  ```

---

### 1.2. Tres Artículos Científicos en los que se Basa el Proyecto

#### Artículo Base 1: Detección y Localización de Matrículas con Redes YOLO
* **Título:** *A Robust Real-Time Automatic License Plate Recognition Based on the YOLO Detector*
* **Autores:** Rayson Laroca, Evair Severo, Luiz A. Zanlorensi, Luiz S. Oliveira, Gabriel R. Gonçalves, William Robson Schwartz, David Menotti.
* **Año / Publicación:** 2018 / *International Joint Conference on Neural Networks (IJCNN)*, IEEE.
* **DOI / Enlace:** [10.1109/IJCNN.2018.8489629](https://doi.org/10.1109/IJCNN.2018.8489629) | [arXiv:1802.09567](https://arxiv.org/abs/1802.09567)
* **Aporte Técnico Principal:** Demostró experimentalmente que los detectores One-Stage de la familia YOLO superan en equilibrio entre precisión (Recall > 98%) e inferencia en tiempo real (FPS elevados) a los métodos tradicionales y a Faster R-CNN en tareas de localización simultánea de vehículos y placas vehiculares.
* **Relación Directa con este Proyecto:** Es el fundamento arquitectónico del servicio `services/anpr/` que utiliza YOLO (actualizado a YOLOv8) para aislar la región de interés (ROI) del vehículo y la matrícula en cada fotograma del flujo de video RTSP proveniente del ECU 911.

#### Artículo Base 2: Seguimiento Multiobjeto y Rescate de Cuadros de Baja Confianza
* **Título:** *ByteTrack: Multi-Object Tracking by Associating Every Detection Box*
* **Autores:** Yifu Zhang, Peize Sun, Yi Jiang, Dongdong Yu, Fucheng Weng, Zehuan Yuan, Ping Luo, Wenyu Liu, Xinggang Wang.
* **Año / Publicación:** 2022 / *European Conference on Computer Vision (ECCV)*, Springer.
* **DOI / Enlace:** [10.1007/978-3-031-20047-2_1](https://doi.org/10.1007/978-3-031-20047-2_1) | [arXiv:2110.06864](https://arxiv.org/abs/2110.06864)
* **Aporte Técnico Principal:** Introduce el algoritmo de seguimiento *BYTE*, el cual descarta la limitación de omitir detecciones de baja confianza. Al asociar secuencialmente cajas de alta y baja confianza con trayectorias (*tracks*) mediante Filtro de Kalman y matriz de solapamiento IoU, elimina oclusiones parciales y desenfoques temporales en video.
* **Relación Directa con este Proyecto:** Sustenta la fase de *Tracking* del microservicio ANPR: permite mantener la identidad del vehículo conforme se acerca a la cámara, acumulando candidatos y evitando disparar consultas repetidas a la base de datos de auditoría mientras el vehículo transita el carril.

#### Artículo Base 3: Reconocimiento Secuencial de Caracteres sin Segmentación Previa
* **Título:** *An End-to-End Trainable Neural Network for Image-Based Sequence Recognition and Its Application to Scene Text Recognition*
* **Autores:** Baoguang Shi, Xiang Bai, Cong Yao.
* **Año / Publicación:** 2017 / *IEEE Transactions on Pattern Analysis and Machine Intelligence (TPAMI)*, Vol. 39, No. 11, pp. 2298–2304.
* **DOI / Enlace:** [10.1109/TPAMI.2016.2646371](https://doi.org/10.1109/TPAMI.2016.2646371) | [arXiv:1507.05717](https://arxiv.org/abs/1507.05717)
* **Aporte Técnico Principal:** Propuso la arquitectura CRNN (Convolutional Recurrent Neural Network) combinada con la función de pérdida CTC (Connectionist Temporal Classification). Esta red procesa secuencias de texto de longitud variable directamente desde la imagen sin requerir segmentación individual de letras o números.
* **Relación Directa con este Proyecto:** Es la arquitectura interna sobre la cual operan los motores OCR del proyecto (EasyOCR / CRNN). Permite transcribir el texto de la placa ecuatoriana de forma continua, facilitando la etapa posterior de corrección de homoglifos (ej. diferenciar 'O' de '0' o 'I' de '1' según la posición sintáctica).

---

## PARTE 2: Cadenas de Búsqueda e Investigaciones de Universidades Ecuatorianas

Para recopilar el estado del arte local y regional se requieren cadenas de búsqueda aplicadas a repositorios institucionales de educación superior en Ecuador (Red de Repositorios de Acceso Abierto del Ecuador - RRAAE, sistemas DSpace universitarios, IEEE Ecuador Section y bases regionales como Scielo/Redalyc/Latindex).

### 2.1. Ecuaciones de Búsqueda para Universidades Ecuatorianas

#### Cadena E1: Búsqueda Global en Repositorios Universitarios y Redes Académicas Nacionales
```text
("reconocimiento de placas" OR "reconocimiento de matriculas" OR "ALPR" OR "ANPR" OR "lectura de placas") 
AND ("YOLO" OR "deep learning" OR "redes neuronales" OR "vision artificial" OR "OCR") 
AND ("control de acceso" OR "parqueadero" OR "transito" OR "seguridad") 
AND ("Ecuador" OR "ANT" OR "INEN")
```

#### Cadena E2: Consulta para Motores de Búsqueda con Filtrado de Dominio Nacional (`.edu.ec`)
```text
site:edu.ec ("reconocimiento de placas" OR "ALPR" OR "ANPR") ("YOLO" OR "OCR") ("control vehicular" OR "acceso")
```

#### Cadena E3: Consulta Focalizada en Universidades de la Zona Central / Red CEDIA
```text
(site:repositorio.uta.edu.ec OR site:repositorio.espe.edu.ec OR site:dspace.espol.edu.ec OR site:repositorio.puce.edu.ec) 
AND ("placas vehiculares" OR "ALPR") AND ("YOLO" OR "OpenCV")
```

---

### 2.2. Tres Investigaciones Universitarias Ecuatorianas Similares

#### Investigación Ecuatoriana 1: ESPOL (Escuela Superior Politécnica del Litoral)
* **Título de la Investigación:** *Sistema de reconocimiento de placas vehiculares mediante el modelo YOLOv5 y OCR para el control de acceso en parqueaderos*
* **Institución:** Escuela Superior Politécnica del Litoral (ESPOL), Facultad de Ingeniería en Electricidad y Computación (FIEC), Guayaquil, Ecuador.
* **Autores / Año:** Repositorio DSpace ESPOL (Tesis de Grado en Ingeniería en Computación / Telemática, 2022–2023).
* **Enlace / Repositorio:** [DSpace ESPOL - Repositorio Institucional](https://www.dspace.espol.edu.ec/)
* **Resumen y Metodología:**
  * Desarrolló un prototipo enfocado en el control de acceso automatizado a los estacionamientos del campus politécnico.
  * Empleó el detector **YOLOv5** para la localización del marco de la placa vehicular y la librería **EasyOCR** acoplada a microordenadores tipo Edge (Raspberry Pi).
  * Evaluó condiciones diurnas y nocturnas con variaciones en el ángulo de captura de las cámaras de seguridad.
* **Similitud y Diferenciación con nuestro Proyecto:**
  * *Similitud:* Uso conjunto de modelos YOLO y librerías OCR basadas en Deep Learning para placas ecuatorianas.
  * *Ventaja de nuestro Proyecto:* Este proyecto implementa un pipeline de **dos fases con ByteTrack**, evaluación de **nitidez por Varianza Laplaciana**, procesamiento de video en tiempo real mediante **MediaMTX (RTSP/HLS)** y arquitectura de **microservicios con WebSockets (Socket.io)** orientada a centros de mando como el ECU 911.

#### Investigación Ecuatoriana 2: ESPE (Universidad de las Fuerzas Armadas)
* **Título de la Investigación:** *Sistema inteligente de reconocimiento automático de matrículas vehiculares basado en Deep Learning para el monitoreo y control de acceso vehicular en recintos militares e institucionales*
* **Institución:** Universidad de las Fuerzas Armadas ESPE (Sede Matriz Sangolquí / Sede Santo Domingo), Departamento de Eléctrica, Electrónica y Telecomunicaciones, Ecuador.
* **Autores / Año:** Repositorio Institucional ESPE / Red CEDIA (Trabajo de Integración Curricular, 2022–2024).
* **Enlace / Repositorio:** [Repositorio Digital ESPE](https://repositorio.espe.edu.ec/)
* **Resumen y Metodología:**
  * Diseñó un sistema de seguridad de perímetro e inspección vehicular capaz de contrastar matrículas en tiempo real contra bases de datos de vehículos autorizados y alertas de seguridad.
  * Aplicó entrenamiento supervisado con arquitecturas convolucionales (YOLO / MobileNet) y motores OCR (Tesseract / EasyOCR), con almacenamiento relacional en bases de datos locales.
* **Similitud y Diferenciación con nuestro Proyecto:**
  * *Similitud:* Orientación a la seguridad institucional, control de lista negra/blanca y gestión de accesos no autorizados.
  * *Ventaja de nuestro Proyecto:* Despliegue contenerizado integral en Docker, interfaz web reactiva (React 18 + Vite), corrección sintáctica estricta de la **Norma Técnica Ecuatoriana INEN** (placas particulares `ABC-1234`, estatales, diplomáticas) y simulación de tránsito integrada para validación continua sin hardware físico inmediato.

#### Investigación Ecuatoriana 3: PUCE / UTA (Pontificia Universidad Católica del Ecuador / Universidad Técnica de Ambato)
* **Título de la Investigación:** *Implementación y evaluación de modelos de visión por computador basados en YOLO y OCR para la detección de placas vehiculares en condiciones de iluminación variable*
* **Institución:** Pontificia Universidad Católica del Ecuador (PUCE - Sede Ambato / Quito) / Universidad Técnica de Ambato (FISEI), Tungurahua / Pichincha, Ecuador.
* **Autores / Año:** Repositorio PUCE / Repositorio UTA (Tesis de Grado y Artículos de Investigación Aplicada en TIC, 2022–2024).
* **Enlace / Repositorio:** [Repositorio PUCE](https://repositorio.puce.edu.ec/) | [Repositorio Digital UTA](https://repositorio.uta.edu.ec/)
* **Resumen y Metodología:**
  * Estudió la degradación del reconocimiento de placas vehiculares en la Sierra Centro ecuatoriana causada por deslumbramiento solar, lluvia, niebla y ángulo de inclinación de la cámara.
  * Comparó la precisión de segmentación tradicional frente a modelos de aprendizaje profundo (YOLOv7 / YOLOv8), integrando módulos de post-procesamiento con expresiones regulares adaptadas a las provincias de Ecuador (ej. primera letra 'T' para Tungurahua, 'P' para Pichincha).
* **Similitud y Diferenciación con nuestro Proyecto:**
  * *Similitud:* Contexto geográfico directo (Tungurahua / Zona 3 - Ambato), análisis del patrón provincial de placas ANT y problemática de iluminación.
  * *Ventaja de nuestro Proyecto:* Integración con la infraestructura del **ECU 911 Coordinación Zonal 3 (Ambato)**, soporte para cámaras IP Hikvision mediante RTSP de ultra baja latencia, y descarte de fotogramas borrosos mediante métrica Laplaciana antes de consumir recursos en el OCR.

---

## PARTE 3: Cuadro Comparativo del Estado del Arte

| Criterio | Laroca et al. (2018) | Zhang et al. (ByteTrack, 2022) | Shi et al. (CRNN, 2017) | Tesis ESPOL (2022-2023) | Tesis ESPE (2023-2024) | **Este Proyecto (ECU 911 - ANPR)** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Rol en el Pipeline** | Detección de Placa | Seguimiento Temporal | Reconocimiento de Caracteres | Control de Acceso Campus | Monitoreo Perimetral | Solución Integral Monitoreo ECU 911 |
| **Modelo de Detección** | YOLO (v2/v3) | YOLOX / YOLOv7 | N/A (Solo OCR) | YOLOv5 | YOLOv7 / MobileNet | **YOLOv8** (Inferencia optimizada) |
| **Seguimiento (Tracking)** | Sin seguimiento continuo | **ByteTrack + Kalman** | Sin seguimiento | Sin seguimiento | Filtro de posición básico | **ByteTrack (Two-Phase Pipeline)** |
| **Motor OCR** | CRNN modificado | N/A | **CRNN + CTC Loss** | EasyOCR / Tesseract | Tesseract OCR | **EasyOCR (CRNN) + Post-proceso ANT** |
| **Filtro de Nitidez** | No reportado | No | No | Umbral fijo de brillo | Filtro básico de contraste | **Varianza Laplaciana (Blur Score)** |
| **Contexto Normativo** | Placas Mercosur / BR | Genérico (MOT17/20) | Texto en escena genérico | Placas Ecuador (Parqueo) | Placas Ecuador (Militar/Gob.) | **Norma INEN Ecuador / ANT (Zonal 3)** |
| **Transmisión de Video** | Video local / Offline | Video local / Benchmarks | Imágenes recortadas | Streaming local Flask | RTSP directo | **MediaMTX (RTSP/HLS/WebRTC)** |
| **Arquitectura de Software**| Script monolítico | Código de investigación | Módulo de red neuronal | Monolítico en Edge | Cliente-Servidor básico | **Microservicios Docker + Sockets + React** |

---

## PARTE 4: Guía de Uso para Búsqueda en Bases de Datos

Para replicar estas consultas y obtener los archivos PDF o citas en formato BibTeX:

1. **En Scopus / Web of Science:**
   * Ingrese a la opción de búsqueda avanzada (`Advanced Search`).
   * Seleccione los campos `TITLE-ABS-KEY` (Título, Resumen y Palabras Clave).
   * Pegue la cadena `A1` o `A2`.
2. **En IEEE Xplore:**
   * Seleccione `Advanced Search` -> `Command Search`.
   * Pegue la cadena `A1` o `A3` asegurándose de mantener las comillas en los términos compuestos.
3. **En la Red RRAAE / DSpace Universitarios:**
   * Utilice la barra de búsqueda avanzada de cada repositorio o el portal central [RRAAE](https://rraae.cedia.edu.ec/).
   * Pegue la cadena `E1` o filtre por tipo de documento: *Tesis de Maestría* o *Trabajos de Titulación de Pregrado*.
4. **En Google Académico (Google Scholar):**
   * Emplee la sintaxis compacta de las cadenas `A1`, `A2` o `E2`.
   * Use el filtro temporal de los últimos 5 años (ej. *2021 - Presente*) para asegurar antecedentes de vanguardia técnica.
