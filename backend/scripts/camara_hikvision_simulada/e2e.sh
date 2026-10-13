#!/bin/bash
# Prueba de punta a punta con una cámara Hikvision simulada (docs/CAMARA_HIKVISION_ANPR.md §6).
#
# Requisitos: el sistema en ejecución con Docker Compose (red anpr_default, contenedores
# anpr-backend, anpr-service y anpr-mediamtx) y capturas de ingresos en services/anpr/media
# (ingreso_*.jpg) para armar la escena. Uso, desde la raíz del repositorio:
#
#   bash backend/scripts/camara_hikvision_simulada/e2e.sh
#
# 1. Genera la escena (la primera vez) y la codifica como una Hikvision: principal H.265 1080p
#    25 fps (GOP 25, sin B-frames, ~4 Mb/s) y secundario H.264 640×360 (~0,5 Mb/s).
# 2. Levanta camara-hik (MediaMTX 1.21 con FFmpeg): RTSP en el 554, Digest, admin con contraseña
#    con símbolos y las rutas /Streaming/Channels/101 y 102.
# 3. Registra la cámara, verifica cifrado, diagnóstico Digest, edición, zonas, video y motor; mide 40 s
#    de análisis y un corte de red de 15 s (docker network disconnect) con su recuperación.
# 4. Limpia: borra las detecciones y la cámara de prueba, restaura la cámara del motor y elimina
#    camara-hik. El resultado queda en .trabajo/resultado_e2e.txt.
set -u
D="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
W="$D/.trabajo"
IMG=bluenviron/mediamtx:1.21.1-ffmpeg
RED="${RED:-anpr_default}"
export MSYS_NO_PATHCONV=1
mkdir -p "$W"
R="$W/resultado_e2e.txt"
: > "$R"
log() { echo "$*" | tee -a "$R"; }
nodo() { docker exec -e NODE_PATH=/app/node_modules anpr-backend node /tmp/e2e_hik.js "$@"; }
estado() { nodo estado "$ID"; }

if [ ! -f "$W/principal_h265.mp4" ] || [ ! -f "$W/vista_h264.mp4" ]; then
  log "== 0. Escena de prueba y codificación"
  docker cp "$D/escena.py" anpr-service:/tmp/escena.py >/dev/null
  docker exec anpr-service python /tmp/escena.py | tee -a "$R" || exit 1
  docker cp anpr-service:/tmp/escena.avi "$W/escena.avi" >/dev/null
  docker exec anpr-service rm -f /tmp/escena.py /tmp/escena.avi
  docker run --rm -v "$W:/w" --entrypoint ffmpeg "$IMG" -hide_banner -loglevel error -y -i /w/escena.avi \
    -c:v libx265 -preset fast -pix_fmt yuv420p -b:v 4M -maxrate 4M -bufsize 4M \
    -x265-params keyint=25:min-keyint=25:scenecut=0:bframes=0:log-level=error /w/principal_h265.mp4 || exit 1
  docker run --rm -v "$W:/w" --entrypoint ffmpeg "$IMG" -hide_banner -loglevel error -y -i /w/escena.avi \
    -vf scale=640:360 -c:v libx264 -preset fast -profile:v main -pix_fmt yuv420p -b:v 512k -maxrate 512k -bufsize 512k \
    -g 25 -keyint_min 25 -sc_threshold 0 -bf 0 /w/vista_h264.mp4 || exit 1
fi
cp "$D/camara.yml" "$W/camara.yml"
docker rm -f camara-hik >/dev/null 2>&1
docker run -d --name camara-hik --network "$RED" --network-alias camara-hik -v "$W:/w" "$IMG" /w/camara.yml >/dev/null || exit 1
for i in $(seq 1 20); do docker logs camara-hik 2>&1 | grep -q "Streaming/Channels/101\] stream is available" && break; sleep 1; done
docker cp "$D/e2e_hikvision.js" anpr-backend:/tmp/e2e_hik.js >/dev/null

log "== 1. Alta, cifrado, diagnóstico Digest, edición y asignación al motor"
nodo crear | tee -a "$R"
ID=$(grep -o '^ID=[0-9]*' "$R" | cut -d= -f2)
PREVIA=$(grep -o '^PREVIA=.*' "$R" | cut -d= -f2)
if [ -z "$ID" ]; then log "sin cámara creada: fin"; docker rm -f camara-hik >/dev/null; exit 1; fi

log "== 2. Diagnóstico con la contraseña correcta e incorrecta"
nodo sonda | tee -a "$R"

log "== 2b. Zonas: área de detección y zona de exclusión (las aplica el motor)"
nodo zonas "$ID" | tee -a "$R"

log "== 3. Flujos a través de MediaMTX (lectura RTSP con las credenciales del motor)"
for ruta in "cam_${ID}_vista" "cam_${ID}"; do
  docker exec anpr-service sh -c "ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name,profile,width,height,has_b_frames -of compact \"rtsp://anpr:\${ANPR_SERVICE_TOKEN}@mediamtx:8554/$ruta\"" 2>&1 | sed "s|^|$ruta: |" | tee -a "$R"
done

log "== 4. Análisis continuo durante 40 s"
for i in 1 2 3 4; do sleep 10; estado | tee -a "$R"; done

log "== 5. Corte de red de la cámara durante 15 s (cable desconectado) y recuperación"
docker network disconnect "$RED" camara-hik >/dev/null
t0=$(date +%s)
for i in $(seq 1 6); do sleep 2; echo "  +$(( $(date +%s) - t0 )) s $(estado)" | tee -a "$R"; done
restante=$(( 15 - ($(date +%s) - t0) ))
[ "$restante" -gt 0 ] && sleep "$restante"
docker network connect --alias camara-hik "$RED" camara-hik >/dev/null
t1=$(date +%s)
log "red restablecida; esperando cuadros en el motor…"
recuperada=""
for i in $(seq 1 45); do
  sleep 1
  e=$(estado)
  if echo "$e" | grep -q '"conectada":true' && echo "$e" | grep -qE '"ultimo_cuadro_hace_s":0(\.[0-9])?[,}]'; then
    recuperada=$(( $(date +%s) - t1 )); log "  recuperada en ${recuperada} s: $e"; break
  fi
done
[ -z "$recuperada" ] && log "  ✘ el motor no se recuperó en 45 s: $(estado)"

log "== 6. Limpieza"
nodo limpiar "$ID" "$PREVIA" | tee -a "$R"
docker exec anpr-backend rm -f /tmp/e2e_hik.js
docker rm -f camara-hik >/dev/null
log "resultado completo en $R"
grep -q "✘" "$R" && exit 1 || exit 0
