import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import api, { API_URL } from '../services/api';
import {
  ShieldAlert,
  CheckCircle,
  Edit,
  Calendar,
  MapPin,
  Volume2,
  VolumeX,
  AlertOctagon,
  Video,
  Cpu,
  Activity,
  Car,
  UserCheck,
  HelpCircle,
  Trash2,
  RefreshCw,
  Loader2,
  Camera,
  VideoOff,
  Play,
  Square
} from 'lucide-react';
import DualZoomModal, { DualZoomData } from '../components/DualZoomModal';
import UnauthorizedAccessModal from '../components/UnauthorizedAccessModal';

const ANPR_URL = import.meta.env.VITE_ANPR_URL || 'http://127.0.0.1:8000';
const ANPR_WS_URL = (import.meta.env.VITE_ANPR_URL || 'http://127.0.0.1:8000').replace(/^http/, 'ws');

interface DeteccionItem {
  id: number;
  placa: string;
  placa_reconocida?: string;
  confianza_deteccion?: number;
  confianza_ocr?: number;
  ruta_imagen_ingreso?: string;
  ruta_imagen_placa?: string;
  imagen_vehiculo_path?: string;
  imagen_placa_path?: string;
  fecha_hora_ingreso?: string;
  fecha_hora_procesamiento?: string;
  fecha_hora?: string;
  tracking_id?: number;
  fuente?: string;
  estado_procesamiento?: 'pendiente_ocr' | 'procesado' | 'no_legible' | 'error' | string;
  estado_validacion?: 'autorizado' | 'alerta' | 'no_reconocido' | 'pendiente_revision' | string;
  camara_nombre?: string;
  camara_ubicacion?: string;
  propietario?: string;
  departamento?: string;
  tipo_vehiculo?: string;
  alerta_detectada?: boolean;
  alerta_motivo?: string;
  nivel_alerta?: string;
  validado_manualmente?: boolean;
  placa_validada?: string;
}

interface StatsData {
  total_hoy: number;
  autorizados_hoy: number;
  alertas_hoy: number;
  no_reconocidos_hoy: number;
  pendientes_hoy: number;
}

interface IngresoReciente {
  id: number;
  placa: string;
  confianza_ocr: number | null;
  confianza_deteccion: number | null;
  estado_validacion: string;
  estado_procesamiento: string;
  fecha_hora_ingreso: string;
  tracking_id: number;
  ruta_imagen_ingreso: string | null;
  ruta_imagen_placa: string | null;
  camara_nombre: string;
  camara_ubicacion: string;
  tipo_vehiculo: string;
  propietario: string;
  alerta_id: number | null;
  validado_manualmente?: boolean | number;
}

const Dashboard: React.FC = () => {
  const [detecciones, setDetecciones] = useState<DeteccionItem[]>([]);
  const [ingresoRecientes, setIngresoRecientes] = useState<IngresoReciente[]>([]);
  const [zoomImagen, setZoomImagen] = useState<DualZoomData | null>(null);
  const [alertaActiva, setAlertaActiva] = useState<DeteccionItem | null>(null);
  const [modalAlertaOpen, setModalAlertaOpen] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [streamError, setStreamError] = useState<boolean>(false);
  const [streamKey, setStreamKey] = useState<number>(Date.now());
  const streamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamWsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [streamWebFps, setStreamWebFps] = useState<number>(0);
  const [streamUseFallback, setStreamUseFallback] = useState<boolean>(false);

  const [stats, setStats] = useState<StatsData>({
    total_hoy: 0,
    autorizados_hoy: 0,
    alertas_hoy: 0,
    no_reconocidos_hoy: 0,
    pendientes_hoy: 0
  });

  const [anprStatus, setAnprStatus] = useState<{ online: boolean; fps: number; model: string }>({
    online: false,
    fps: 0,
    model: 'PaddleOCR + Selector Mejor Frame'
  });

  const [showValidador, setShowValidador] = useState(false);
  const [selectedDeteccion, setSelectedDeteccion] = useState<DeteccionItem | null>(null);
  const [placaManual, setPlacaManual] = useState('');
  const [tipoVehiculoManual, setTipoVehiculoManual] = useState('Automóvil');

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const canalParam = searchParams.get('canal');
  const [activeChannelInfo, setActiveChannelInfo] = useState<{ id: number; nombre: string; rtsp_url: string; ip?: string } | null>(null);

  // Estados independientes de encendido por canal para optimización de recursos y aislamiento de submenús
  const [channelPowerStates, setChannelPowerStates] = useState<Record<string, 'stream' | 'webcam' | 'off'>>({});
  const activeChannelKey = canalParam ? `canal_${canalParam}` : 'main';
  const videoMode = channelPowerStates[activeChannelKey] ?? 'stream';

  const setVideoMode = (newMode: 'stream' | 'webcam' | 'off') => {
    setChannelPowerStates(prev => ({
      ...prev,
      [activeChannelKey]: newMode
    }));
  };

  const [webcamLoading, setWebcamLoading] = useState(false);
  const [webcamError, setWebcamError] = useState<string | null>(null);
  const [webcamFps, setWebcamFps] = useState<number>(0);
  const [webcamLatency, setWebcamLatency] = useState<number>(0);
  const [isSwitchingChannel, setIsSwitchingChannel] = useState(false);

  // Efecto para conmutar canal RTSP en caliente en el motor ANPR
  useEffect(() => {
    // Si la webcam local estaba encendida, detenerla para liberar hardware de cámara y CPU
    if (localStreamRef.current) {
      stopWebcam();
    }

    setIsSwitchingChannel(true);

    if (canalParam) {
      api.get('/camaras').then(res => {
        if (res.data && Array.isArray(res.data)) {
          const found = res.data.find((c: any) => String(c.id) === String(canalParam));
          if (found) {
            setActiveChannelInfo(found);
            const channelKey = `canal_${canalParam}`;
            const targetMode = channelPowerStates[channelKey] ?? 'stream';
            if (targetMode === 'stream') {
              fetch(`${ANPR_URL}/api/camera/switch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  camera_id: found.id,
                  source_type: 'rtsp',
                  rtsp_url: found.rtsp_url,
                  nombre: found.nombre
                })
              }).then(() => {
                setStreamError(false);
                setTimeout(() => {
                  setStreamKey(Date.now());
                  setIsSwitchingChannel(false);
                }, 200);
              }).catch(err => {
                console.error('Error al cambiar cámara ANPR:', err);
                setIsSwitchingChannel(false);
              });
            } else {
              setIsSwitchingChannel(false);
            }
          } else {
            setIsSwitchingChannel(false);
          }
        } else {
          setIsSwitchingChannel(false);
        }
      }).catch(err => {
        console.error('Error al consultar lista de cámaras:', err);
        setIsSwitchingChannel(false);
      });
    } else {
      setActiveChannelInfo(null);
      // Conmutar a cámara principal en ANPR
      fetch(`${ANPR_URL}/api/camera/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_id: 1,
          source_type: 'webcam',
          nombre: 'Cámara Principal / Webcam'
        })
      }).then(() => {
        setTimeout(() => {
          setStreamKey(Date.now());
          setIsSwitchingChannel(false);
        }, 200);
      }).catch(() => {
        setIsSwitchingChannel(false);
      });
    }
  }, [canalParam]);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const localTimerRef = useRef<number | null>(null);
  const isSendingFrameRef = useRef<boolean>(false);
  const webcamFrameCountRef = useRef<number>(0);
  const webcamLastFpsTimeRef = useRef<number>(Date.now());
  // WebSocket dedicado para streaming binário de frames de webcam al backend
  const webcamWsRef = useRef<WebSocket | null>(null);
  // Cache de ROIs para renderizado continuo independiente del ciclo de detención
  const lastRoisRef = useRef<any[]>([]);
  const hudRafRef = useRef<number | null>(null);

  const socketRef = useRef<any>(null);

  // Asegurar que el elemento video reciba el stream cuando React lo monta en el DOM
  useEffect(() => {
    if (videoMode === 'webcam' && localStreamRef.current && localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play().catch(err => {
        console.warn('[Webcam] Autoplay bloqueado por el navegador:', err);
      });
    }
  }, [videoMode, webcamLoading]);

  // Limpieza al desmontar componente
  useEffect(() => {
    return () => {
      if (localTimerRef.current) clearInterval(localTimerRef.current);
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }
      if (hudRafRef.current) cancelAnimationFrame(hudRafRef.current);
    };
  }, []);

  // Stream WebSocket en Vivo con Cero Latencia (< 20ms) para HTML5 Canvas
  useEffect(() => {
    if (videoMode !== 'stream' || isSwitchingChannel) {
      if (streamWsRef.current) {
        streamWsRef.current.close();
        streamWsRef.current = null;
      }
      setWsConnected(false);
      return;
    }

    let isDisposed = false;
    let isDrawing = false;
    let frameCount = 0;
    let lastFpsTime = performance.now();

    const wsUrl = `${ANPR_WS_URL}/ws/stream`;
    console.log('[RealtimeStream] Conectando a WebSocket:', wsUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'blob';
      streamWsRef.current = ws;
    } catch (e) {
      console.warn('[RealtimeStream] Fallo al crear WebSocket, usando fallback:', e);
      setStreamUseFallback(true);
      return;
    }

    ws.onopen = () => {
      if (isDisposed) return;
      console.log('[RealtimeStream] WebSocket conectado con éxito (Modo Cero Latencia)');
      setWsConnected(true);
      setStreamUseFallback(false);
      setStreamError(false);
    };

    ws.onmessage = async (event: MessageEvent) => {
      if (isDisposed || isDrawing) return; // Drop frame if browser is still painting previous
      isDrawing = true;
      try {
        const bitmap = await createImageBitmap(event.data);
        if (isDisposed) {
          bitmap.close();
          return;
        }
        const canvas = streamCanvasRef.current;
        if (canvas) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0);
          }
        }
        bitmap.close();

        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
          setStreamWebFps(Math.round((frameCount * 1000) / (now - lastFpsTime)));
          frameCount = 0;
          lastFpsTime = now;
        }
      } catch {
        // Cuadro corrupto o cancelado
      } finally {
        isDrawing = false;
      }
    };

    ws.onerror = (err) => {
      console.warn('[RealtimeStream] WebSocket error, conmutando a respaldo HTTP MJPEG:', err);
      if (!isDisposed) {
        setStreamUseFallback(true);
      }
    };

    ws.onclose = () => {
      if (!isDisposed) {
        setWsConnected(false);
      }
    };

    return () => {
      isDisposed = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [videoMode, isSwitchingChannel, streamKey]);

  // ---------------------------------------------------------------------------
  // Control: Stream Servidor / Hikvision / Docker
  // ---------------------------------------------------------------------------
  const startServerStream = () => {
    // Apagar webcam local si estaba corriendo
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (localTimerRef.current) {
      clearInterval(localTimerRef.current);
      localTimerRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setWebcamFps(0);
    setStreamError(false);
    setStreamKey(Date.now());
    setVideoMode('stream');

    if (activeChannelInfo) {
      fetch(`${ANPR_URL}/api/camera/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_id: activeChannelInfo.id,
          source_type: 'rtsp',
          rtsp_url: activeChannelInfo.rtsp_url,
          nombre: activeChannelInfo.nombre
        })
      }).catch(err => console.error('Error al reactivar cámara RTSP:', err));
    }
  };

  const stopServerStream = () => {
    setVideoMode('off');
  };

  // ---------------------------------------------------------------------------
  // Control: Webcam Local del Navegador — Modo WebSocket de Ultra-Baja Latencia
  // ---------------------------------------------------------------------------
  const startWebcam = async () => {
    try {
      setWebcamLoading(true);
      setWebcamError(null);

      // Detener cualquier stream anterior
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
      if (webcamWsRef.current) {
        webcamWsRef.current.close();
        webcamWsRef.current = null;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: false,
        });
      } catch (errConstraint) {
        console.warn('Fallback a getUserMedia básico:', errConstraint);
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      localStreamRef.current = stream;
      setVideoMode('webcam');
      setWebcamLoading(false);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.play().catch(e => console.warn('Autoplay error:', e));
      }

      // --- Conexión WebSocket para streaming binario de frames ---
      const wsUrl = `${ANPR_WS_URL}/ws/webcam`;
      console.log('[WebcamWS] Conectando a', wsUrl);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      webcamWsRef.current = ws;

      ws.onopen = () => {
        console.log('[WebcamWS] Conectado. Iniciando streaming a 30fps.');
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.rois !== undefined) {
            drawWebcamHUD(data.rois, data.motion_bbox, data.motion_pct, data.motion_vehicle_detected);
          }
        } catch {
          // frame corrupto, ignorar
        }
      };

      ws.onerror = (e) => {
        console.warn('[WebcamWS] Error WS, fallback a HTTP:', e);
        // Fallback: reiniciar con HTTP polling si WS falla
        if (localTimerRef.current) clearInterval(localTimerRef.current);
        webcamFrameCountRef.current = 0;
        webcamLastFpsTimeRef.current = Date.now();
        localTimerRef.current = window.setInterval(sendWebcamFrame, 50);
      };

      ws.onclose = () => {
        console.log('[WebcamWS] Conexión cerrada.');
      };

      // --- Loop de envio de frames al WS a 33ms (~30fps) ---
      if (localTimerRef.current) clearInterval(localTimerRef.current);
      webcamFrameCountRef.current = 0;
      webcamLastFpsTimeRef.current = Date.now();
      isSendingFrameRef.current = false;
      localTimerRef.current = window.setInterval(sendWebcamFrameWs, 33);

      // --- Loop RAF para HUD a 60fps, completamente desacoplado ---
      if (hudRafRef.current) cancelAnimationFrame(hudRafRef.current);
      lastRoisRef.current = [];
      hudRafRef.current = requestAnimationFrame(renderHUDFrame);
    } catch (err: any) {
      console.error('Error accediendo a webcam:', err);
      setWebcamError('No se pudo acceder a la webcam local: ' + (err.message || 'Verifica los permisos de cámara en tu navegador.'));
      setWebcamLoading(false);
    }
  };

  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionBboxRef = useRef<[number, number, number, number] | null>(null);
  const motionPctRef = useRef<number>(0);
  const motionLastSeenRef = useRef<number>(0);
  // Nueva bandera: solo mostrar cuadro de movimiento si el backend confirmó un vehículo en esa zona
  const motionVehicleRef = useRef<boolean>(false);

  const animatedTracksRef = useRef<Map<number, {
    id: number;
    anchorBbox: [number, number, number, number];
    currentBbox: [number, number, number, number];
    orientedBox?: [number, number][];
    vx: number;
    vy: number;
    confidence: number;
    plate: string;
    partialPlate: string;   // Texto OCR parcial para mostrar mientras se escanea
    status: string;
    plateConfidence: number;
    lastSeen: number;
    lastUpdate: number;    // Timestamp del último update del servidor (para extrapolación)
    opacity: number;
  }>>(new Map());
  const lastRafTimeRef = useRef<number>(performance.now());

  /**
   * Renderiza el HUD de bounding boxes sobre el canvas overlay a 60 FPS continuos.
   *
   * Arquitectura SOTA 2026 (Rekor Scout / OpenALPR):
   * - Caja orientada de 4 vértices (polígono rotado con inclinación de la mano).
   * - Zona de Interés de Movimiento MOG2 (cuadro verde translúcido dinámico).
   * - Mapeo 1:1 de coordenadas sin desfase ni latencia.
   * - Badge táctico Glassmorphism con indicador de estado y matrícula ANT Ecuador.
   */
  const renderHUDFrame = () => {
    const canvas = overlayCanvasRef.current;
    const video = localVideoRef.current;
    if (!canvas || !video) {
      hudRafRef.current = requestAnimationFrame(renderHUDFrame);
      return;
    }

    const rect = video.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
      canvas.width = Math.round(rect.width);
      canvas.height = Math.round(rect.height);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      hudRafRef.current = requestAnimationFrame(renderHUDFrame);
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - (lastRafTimeRef.current || now)) / 1000));
    lastRafTimeRef.current = now;

    // Corrección geométrica exacta por object-fit: contain (pillarbox / letterbox)
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const videoRatio = vw / vh;
    const elementRatio = rect.width / (rect.height || 1);

    let renderWidth = rect.width;
    let renderHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (elementRatio > videoRatio) {
      renderWidth = rect.height * videoRatio;
      offsetX = (rect.width - renderWidth) / 2;
    } else {
      renderHeight = rect.width / videoRatio;
      offsetY = (rect.height - renderHeight) / 2;
    }

    // Dimensiones del frame de inferencia enviado al backend
    const targetW = 640;
    const targetH = Math.round(640 * (vh / vw));

    const scaleX = renderWidth / targetW;
    const scaleY = renderHeight / targetH;

    // ─────────────────────────────────────────────────────────────────────────
    // 0. Renderizar Zona de Interés de Movimiento MOG2 — INTELIGENTE PARA AUTOS
    // Solo se muestra si el backend confirmó un vehículo en esa zona (motionVehicleRef=true).
    // Elimina el parpadeo de cuadro verde cuando se mueve una persona, sombra u objeto.
    // ─────────────────────────────────────────────────────────────────────────
    if (
      motionBboxRef.current &&
      now - motionLastSeenRef.current < 600 &&
      motionPctRef.current > 3 &&
      motionVehicleRef.current   // <— NUEVO: filtro inteligente por vehículo
    ) {
      const [mx1_raw, my1_raw, mx2_raw, my2_raw] = motionBboxRef.current;
      const mx1 = offsetX + mx1_raw * scaleX;
      const my1 = offsetY + my1_raw * scaleY;
      const mx2 = offsetX + mx2_raw * scaleX;
      const my2 = offsetY + my2_raw * scaleY;
      const mw = Math.max(12, mx2 - mx1);
      const mh = Math.max(12, my2 - my1);

      const mAge = now - motionLastSeenRef.current;
      const mAlpha = Math.max(0, 1 - mAge / 600) * 0.7;

      ctx.save();
      ctx.globalAlpha = mAlpha;

      // Relleno verde translúcido característico de Rekor Scout
      ctx.fillStyle = 'rgba(34, 197, 94, 0.10)';
      ctx.fillRect(mx1, my1, mw, mh);

      // Borde punteado fino de zona activa
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(mx1, my1, mw, mh);
      ctx.setLineDash([]);

      // Etiqueta táctica con indicador de VEHÍCULO confirmado por YOLO
      const mLabel = `VEHÍCULO • MOV ${motionPctRef.current}%`;
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      const mTextW = ctx.measureText(mLabel).width;
      const mBadgeW = mTextW + 14;
      const mBadgeY = Math.max(8, my1 - 18);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(mx1, mBadgeY, mBadgeW, 16);
      ctx.fillStyle = '#4ade80';
      ctx.fillText(mLabel, mx1 + 7, mBadgeY + 11.5);

      ctx.restore();
    }

    const tracksMap = animatedTracksRef.current;
    if (tracksMap.size === 0) {
      hudRafRef.current = requestAnimationFrame(renderHUDFrame);
      return;
    }

    const toDelete: number[] = [];

    tracksMap.forEach((track, id) => {
      const timeSinceSeenMs = now - track.lastSeen;
      if (timeSinceSeenMs > 400) {
        track.opacity -= dt * 3.5;
        if (track.opacity <= 0) {
          toDelete.push(id);
          return;
        }
      }

      // Extrapolación Kalman de posición en tiempo real:
      // En vez de anclar el bbox directamente, usamos la velocidad del estado Kalman
      // para predecir la posición actual de la placa entre actualizaciones del servidor.
      // Máximo 80ms de look-ahead para evitar deriva excesiva si el auto frena.
      const timeSinceUpdate = (now - track.lastUpdate) / 1000; // segundos
      const lookAhead = Math.min(0.080, timeSinceUpdate);
      // Los valores vx/vy del servidor están en píxeles del frame de inferencia (640px).
      // Nota: scaleX/scaleY (definidos abajo) aún no están en scope aquí,
      // por eso la extrapolación se aplica en coordenadas de frame y se escala al renderizar.
      const extraX = track.vx * lookAhead;
      const extraY = track.vy * lookAhead;
      track.currentBbox[0] = track.anchorBbox[0] + extraX;
      track.currentBbox[1] = track.anchorBbox[1] + extraY;
      track.currentBbox[2] = track.anchorBbox[2] + extraX;
      track.currentBbox[3] = track.anchorBbox[3] + extraY;

      const bx1 = offsetX + track.currentBbox[0] * scaleX;
      const by1 = offsetY + track.currentBbox[1] * scaleY;
      const bx2 = offsetX + track.currentBbox[2] * scaleX;
      const by2 = offsetY + track.currentBbox[3] * scaleY;
      const bw = Math.max(16, bx2 - bx1);
      const bh = Math.max(10, by2 - by1);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, track.opacity));

      // Color táctico según estado (ámbar Rekor Scout por defecto, verde si autorizado o válido, rojo si alerta)
      const isAlert = track.status === 'alerta';
      const isAuthorized = track.status === 'autorizado' || (track.plate && track.plate.length >= 6);
      let color = '#f59e0b'; // Ámbar estilo OpenALPR Rekor Scout
      let glowColor = 'rgba(245, 158, 11, 0.45)';

      if (isAlert) {
        color = '#ef4444';
        glowColor = 'rgba(239, 68, 68, 0.45)';
      } else if (isAuthorized) {
        color = '#00ff66';
        glowColor = 'rgba(0, 255, 102, 0.45)';
      }

      const hasOriented = track.orientedBox && track.orientedBox.length === 4;

      let badgeX = bx1;
      let badgeY = by1 - 28;

      if (hasOriented) {
        // ─────────────────────────────────────────────────────────────────
        // 1A. Caja Orientada Rotada de 4 Puntos (Estilo Rekor Scout)
        // ─────────────────────────────────────────────────────────────────
        const pts = track.orientedBox!.map(([px, py]) => [
          offsetX + px * scaleX,
          offsetY + py * scaleY,
        ]);

        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 10;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;

        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.closePath();
        ctx.stroke();

        // Relleno sutil del área de la placa
        ctx.fillStyle = isAlert
          ? 'rgba(239, 68, 68, 0.14)'
          : isAuthorized
          ? 'rgba(0, 255, 102, 0.10)'
          : 'rgba(245, 158, 11, 0.10)';
        ctx.fill();

        // Vértices tácticos en las 4 esquinas de la placa
        ctx.shadowBlur = 0;
        ctx.fillStyle = color;
        pts.forEach(([px, py]) => {
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
        });

        // Posicionamiento superior del badge según los puntos
        const minPy = Math.min(...pts.map(p => p[1]));
        const avgPx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
        badgeX = avgPx;
        badgeY = minPy - 26;
      } else {
        // ─────────────────────────────────────────────────────────────────
        // 1B. Fallback: Bounding Box Ortogonal con Corner Brackets
        // ─────────────────────────────────────────────────────────────────
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 10;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;

        const radius = 4;
        ctx.beginPath();
        ctx.roundRect(bx1, by1, bw, bh, radius);
        ctx.stroke();

        // Corner Brackets Tácticos
        const cornerLen = Math.min(12, bw * 0.22, bh * 0.22);
        ctx.lineWidth = 3.5;
        // Superior Izquierda
        ctx.beginPath();
        ctx.moveTo(bx1, by1 + cornerLen);
        ctx.lineTo(bx1, by1);
        ctx.lineTo(bx1 + cornerLen, by1);
        ctx.stroke();
        // Superior Derecha
        ctx.beginPath();
        ctx.moveTo(bx2 - cornerLen, by1);
        ctx.lineTo(bx2, by1);
        ctx.lineTo(bx2, by1 + cornerLen);
        ctx.stroke();
        // Inferior Izquierda
        ctx.beginPath();
        ctx.moveTo(bx1, by2 - cornerLen);
        ctx.lineTo(bx1, by2);
        ctx.lineTo(bx1 + cornerLen, by2);
        ctx.stroke();
        // Inferior Derecha
        ctx.beginPath();
        ctx.moveTo(bx2 - cornerLen, by2);
        ctx.lineTo(bx2, by2);
        ctx.lineTo(bx2, by2 - cornerLen);
        ctx.stroke();

        badgeX = bx1 + bw / 2;
        badgeY = by1 - 26;
      }

      // ─────────────────────────────────────────────────────────────────
      // 2. Badge OCR Flotante Glassmorphism encima de la placa
      // Muestra texto parcial mientras el OCR sigue escaneando (no solo "ESCANEANDO").
      // ─────────────────────────────────────────────────────────────────
      const confPct = track.plateConfidence > 0
        ? Math.round(track.plateConfidence * 100)
        : Math.round(track.confidence * 100);

      const hasPlate = Boolean(track.plate && track.plate.length >= 6);
      const isScanning = !hasPlate && (track.status === 'escaneando' || track.status === '');
      // Si hay texto parcial del OCR, mostrarlo en lugar del genérico "ESCANEANDO"
      const displayText = hasPlate
        ? `${track.plate}  •  ${confPct}%`
        : track.partialPlate && track.partialPlate.length >= 3
          ? `◌ ${track.partialPlate}  •  ${confPct}%`
          : `◌ ESCANEANDO OCR  •  ${confPct}%`;

      ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      const textMetrics = ctx.measureText(displayText);
      const badgeW = textMetrics.width + 24;
      const badgeH = 22;
      const finalBadgeX = Math.max(offsetX + 4, Math.min(rect.width - badgeW - 4, badgeX - badgeW / 2));
      const finalBadgeY = Math.max(26, badgeY);

      // Fondo del Badge (Glassmorphism oscuro)
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.fillStyle = 'rgba(11, 19, 43, 0.92)';
      ctx.beginPath();
      ctx.roundRect(finalBadgeX, finalBadgeY, badgeW, badgeH, 4);
      ctx.fill();

      // Borde del Badge
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Indicador de punto verde/ámbar/rojo
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(finalBadgeX + 10, finalBadgeY + badgeH / 2, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Texto de la Matrícula
      ctx.fillStyle = '#ffffff';
      ctx.fillText(displayText, finalBadgeX + 18, finalBadgeY + 15);

      // Animación de escaner pulsante: barra de progreso debajo del badge
      // mientras el OCR está activo (status='escaneando' o aún sin placa confirmada).
      if (isScanning) {
        const scanProgress = ((now / 800) % 1); // ciclo de 800ms
        const scanBarW = badgeW * scanProgress;
        const scanY = finalBadgeY + badgeH + 2;
        // Fondo gris de la barra
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(finalBadgeX, scanY, badgeW, 3);
        // Barra animada de color ámbar pulsante
        const scanAlpha = 0.5 + 0.5 * Math.sin(now / 200);
        ctx.fillStyle = `rgba(245, 158, 11, ${scanAlpha})`;
        ctx.fillRect(finalBadgeX, scanY, scanBarW, 3);
      }

      ctx.restore();
    });

    toDelete.forEach(id => tracksMap.delete(id));

    hudRafRef.current = requestAnimationFrame(renderHUDFrame);
  };

  const drawWebcamHUD = (
    rois: any[],
    motionBbox?: [number, number, number, number] | null,
    motionPct?: number,
    motionVehicleDetected?: boolean
  ) => {
    const now = performance.now();
    const tracksMap = animatedTracksRef.current;

    if (motionBbox && Array.isArray(motionBbox) && motionBbox.length === 4) {
      motionBboxRef.current = motionBbox;
      motionPctRef.current = motionPct ?? 0;
      motionLastSeenRef.current = now;
      // Actualizar bandera de vehículo detectado: si el backend confirmó un vehículo,
      // mantenerlo visible hasta que expire el cuadro de movimiento (600ms).
      motionVehicleRef.current = motionVehicleDetected ?? false;
    } else {
      // Sin zona de movimiento activa: limpiar la bandera
      motionVehicleRef.current = false;
    }

    rois.forEach((r: any) => {
      if (!r.bbox || r.bbox.length < 4) return;
      const tid = r.tracking_id ?? Math.floor(Math.random() * 100000);
      const vx = Array.isArray(r.velocity) ? (r.velocity[0] ?? 0) : 0;
      const vy = Array.isArray(r.velocity) ? (r.velocity[1] ?? 0) : 0;
      const obox: [number, number][] | undefined =
        Array.isArray(r.oriented_box) && r.oriented_box.length === 4
          ? r.oriented_box
          : undefined;
      // Texto parcial: placa cruda que el OCR leyó aunque aún no sea válida (>= 3 chars)
      const partialPlate = (!r.plate && r.partial_plate && r.partial_plate.length >= 3)
        ? r.partial_plate
        : '';

      if (tracksMap.has(tid)) {
        const trk = tracksMap.get(tid)!;
        trk.anchorBbox = [r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]];
        trk.orientedBox = obox;
        trk.vx = vx;
        trk.vy = vy;
        trk.confidence = r.confidence ?? trk.confidence;
        if (r.plate) {
          trk.plate = r.plate;
          trk.partialPlate = '';
          trk.plateConfidence = r.plate_confidence ?? trk.plateConfidence;
        } else if (partialPlate) {
          trk.partialPlate = partialPlate;
        }
        if (r.status) trk.status = r.status;
        trk.lastSeen = now;
        trk.lastUpdate = now;
        trk.opacity = 1.0;
      } else {
        tracksMap.set(tid, {
          id: tid,
          anchorBbox: [r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]],
          currentBbox: [r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]],
          orientedBox: obox,
          vx,
          vy,
          confidence: r.confidence ?? 0.8,
          plate: r.plate || '',
          partialPlate: partialPlate,
          status: r.status || '',
          plateConfidence: r.plate_confidence || 0,
          lastSeen: now,
          lastUpdate: now,
          opacity: 1.0,
        });
      }
    });
  };

  const stopWebcam = () => {
    // Detener loop de envio de frames
    if (localTimerRef.current) {
      clearInterval(localTimerRef.current);
      localTimerRef.current = null;
    }
    // Cerrar WebSocket de webcam
    if (webcamWsRef.current) {
      webcamWsRef.current.close();
      webcamWsRef.current = null;
    }
    // Detener loop de HUD
    if (hudRafRef.current) {
      cancelAnimationFrame(hudRafRef.current);
      hudRafRef.current = null;
    }
    // Limpiar mapa de tracks
    animatedTracksRef.current.clear();
    lastRoisRef.current = [];
    isSendingFrameRef.current = false;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (overlayCanvasRef.current) {
      const ctx = overlayCanvasRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlayCanvasRef.current.width, overlayCanvasRef.current.height);
    }
    setWebcamFps(0);
    setVideoMode('off');
  };

  /**
   * Envía un frame JPEG comprimido al backend via WebSocket binario.
   * Sin overhead HTTP, sin handshake TCP por frame.
   * Backend responde con JSON de detecciones via ws.onmessage.
   */
  const sendWebcamFrameWs = () => {
    const video = localVideoRef.current;
    const ws = webcamWsRef.current;
    if (!video || video.readyState < 2 || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (isSendingFrameRef.current) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const targetW = 640;
    const targetH = Math.round(640 * (vh / vw));

    const canvas = localCanvasRef.current || document.createElement('canvas');
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, targetW, targetH);

    isSendingFrameRef.current = true;
    const t0 = performance.now();

    // JPEG al 55% — balance óptimo entre calidad y tamaño (~10-14KB)
    canvas.toBlob((blob) => {
      if (!blob) { isSendingFrameRef.current = false; return; }
      blob.arrayBuffer().then(buf => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(buf);
        } catch {
          // WS cerró entretanto
        } finally {
          isSendingFrameRef.current = false;
          const latency = Math.round(performance.now() - t0);
          setWebcamLatency(latency);
          webcamFrameCountRef.current += 1;
          const now = Date.now();
          const dt = (now - webcamLastFpsTimeRef.current) / 1000;
          if (dt >= 1.0) {
            setWebcamFps(Math.round(webcamFrameCountRef.current / dt));
            webcamFrameCountRef.current = 0;
            webcamLastFpsTimeRef.current = now;
          }
        }
      });
    }, 'image/jpeg', 0.55);
  };

  /**
   * Fallback HTTP POST (usado si WebSocket no está disponible / onerror).
   */
  const sendWebcamFrame = () => {
    const video = localVideoRef.current;
    if (!video || video.readyState < 2 || isSendingFrameRef.current) return;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const targetW = 640;
    const targetH = Math.round(640 * (vh / vw));

    const canvas = localCanvasRef.current || document.createElement('canvas');
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, targetW, targetH);

    isSendingFrameRef.current = true;
    const t0 = performance.now();

    canvas.toBlob(async (blob) => {
      if (!blob) {
        isSendingFrameRef.current = false;
        return;
      }
      try {
        const fd = new FormData();
        fd.append('file', blob, 'frame.jpg');
        const res = await fetch(`${ANPR_URL}/process/frame`, {
          method: 'POST',
          body: fd,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.rois) {
            drawWebcamHUD(data.rois, data.motion_bbox, data.motion_pct, data.motion_vehicle_detected);
          }
          const latency = Math.round(performance.now() - t0);
          setWebcamLatency(latency);

          webcamFrameCountRef.current += 1;
          const now = Date.now();
          const dt = (now - webcamLastFpsTimeRef.current) / 1000;
          if (dt >= 1.0) {
            setWebcamFps(Math.round(webcamFrameCountRef.current / dt));
            webcamFrameCountRef.current = 0;
            webcamLastFpsTimeRef.current = now;
          }
        }
      } catch (e) {
        // Silencioso
      } finally {
        isSendingFrameRef.current = false;
      }
    }, 'image/jpeg', 0.65);
  };

  const getMediaUrl = (imgPath?: string) => {
    if (!imgPath) return '';
    if (imgPath.startsWith('data:') || imgPath.startsWith('http://') || imgPath.startsWith('https://')) return imgPath;
    const filename = imgPath.split('/').pop()?.split('\\').pop();
    if (!filename) return '';
    const baseUrl = API_URL.replace(/\/api\/?$/, '');
    return `${baseUrl}/media/${filename}`;
  };

  const handleImageError = (e: React.SyntheticEvent<HTMLImageElement, Event>, imgPath?: string) => {
    const target = e.currentTarget;
    if (!target.dataset.retried && imgPath) {
      target.dataset.retried = 'true';
      const filename = imgPath.split('/').pop()?.split('\\').pop();
      if (filename) {
        target.src = `${ANPR_URL}/media/${filename}`;
      }
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Carga de Datos y WebSockets
  // ───────────────────────────────────────────────────────────────────────────
  const fetchInicial = async () => {
    try {
      const res = await api.get('/detecciones');
      if (res.data) {
        const validas = res.data.filter((d: DeteccionItem) => d.fuente !== 'simulacion');
        setDetecciones(validas.slice(0, 15));
      }
    } catch (err) {
      try {
        const resLegacy = await api.get('/eventos');
        const validas = resLegacy.data.filter((d: any) => !d.imagen_vehiculo_path?.includes('simulado'));
        setDetecciones(validas.slice(0, 15));
      } catch {
        // Sin registros iniciales
      }
    }
  };

  const fetchRecientes = async () => {
    try {
      const res = await api.get('/detecciones/recientes?limite=20');
      if (Array.isArray(res.data)) {
        setIngresoRecientes(res.data);
      }
    } catch {
      // Ignorar silenciosamente
    }
  };

  const fetchStats = async () => {
    try {
      const res = await api.get('/detecciones/stats');
      if (res.data) {
        setStats(res.data);
      }
    } catch {
      // Ignorar
    }
  };

  const checkAnprService = async () => {
    try {
      const res = await fetch(`${ANPR_URL}/status`);
      if (res.ok) {
        const data = await res.json();
        setAnprStatus({
          online: true,
          fps: data.capture_fps || 30,
          model: 'PaddleOCR + Selector de Frame'
        });
        setStreamError(false);
      } else {
        setAnprStatus(prev => ({ ...prev, online: false }));
      }
    } catch {
      setAnprStatus(prev => ({ ...prev, online: false }));
    }
  };

  useEffect(() => {
    fetchInicial();
    fetchStats();
    fetchRecientes();
    checkAnprService();
    const intervalAnpr = setInterval(checkAnprService, 4000);
    const intervalRecientes = setInterval(fetchRecientes, 10000);

    // Conectar WebSocket Socket.IO
    const socketServer = API_URL.replace('/api', '');
    const socket = io(socketServer);
    socketRef.current = socket;

    // FASE 1: Evento de Captura Fotográfica Disparada (Pendiente OCR)
    socket.on('nuevo_ingreso_pendiente', (nuevo: DeteccionItem) => {
      console.log('[Socket] Fase 1 — Foto capturada (Pendiente OCR):', nuevo);
      setDetecciones(prev => [nuevo, ...prev.filter(d => d.id !== nuevo.id).slice(0, 14)]);
      fetchStats();
    });

    // FASE 2: Evento de OCR Completado por el Worker
    socket.on('ingreso_actualizado', (actualizado: DeteccionItem) => {
      console.log('[Socket] Fase 2 — OCR Completado:', actualizado);
      setDetecciones(prev => {
        const index = prev.findIndex(d => d.id === actualizado.id);
        if (index !== -1) {
          const copia = [...prev];
          copia[index] = actualizado;
          return copia;
        }
        return [actualizado, ...prev.slice(0, 14)];
      });
      fetchStats();
      fetchRecientes();

      if (actualizado.estado_validacion === 'alerta' || actualizado.alerta_detectada || actualizado.estado_validacion === 'no_reconocido') {
        setAlertaActiva(actualizado);
        setModalAlertaOpen(true);
        if (soundEnabled) playAlertSound();
      } else if (actualizado.estado_validacion === 'autorizado') {
        if (soundEnabled) playAuthorizedSound();
      }
    });

    socket.on('nueva_deteccion', (det: DeteccionItem) => {
      setDetecciones(prev => {
        const index = prev.findIndex(d => d.id === det.id);
        if (index !== -1) {
          const copia = [...prev];
          copia[index] = det;
          return copia;
        }
        return [det, ...prev.slice(0, 14)];
      });
      fetchStats();

      if (det.estado_validacion === 'alerta' || det.alerta_detectada || det.estado_validacion === 'no_reconocido') {
        setAlertaActiva(det);
        setModalAlertaOpen(true);
        if (soundEnabled) playAlertSound();
      } else if (det.estado_validacion === 'autorizado') {
        if (soundEnabled) playAuthorizedSound();
      }
    });

    socket.on('alerta_vehiculo', (alerta: DeteccionItem) => {
      setAlertaActiva(alerta);
      setModalAlertaOpen(true);
      if (soundEnabled) playAlertSound();
    });

    return () => {
      if (socket) socket.disconnect();
      clearInterval(intervalAnpr);
      clearInterval(intervalRecientes);
    };
  }, [soundEnabled]);

  // ---------------------------------------------------------------------------
  // Notificación Sonora: VEHÍCULO AUTORIZADO (Melodía Armónica Ascendente ~1.8s)
  // ---------------------------------------------------------------------------
  const playAuthorizedSound = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const now = audioCtx.currentTime;

      // Secuencia armónica agradable: Do5 (523Hz) -> Mi5 (659Hz) -> Sol5 (784Hz) -> Do6 (1046Hz)
      const notes = [
        { freq: 523.25, start: 0.00, dur: 0.35, gain: 0.20 },
        { freq: 659.25, start: 0.22, dur: 0.40, gain: 0.22 },
        { freq: 783.99, start: 0.48, dur: 1.10, gain: 0.25 },
        { freq: 1046.50, start: 0.70, dur: 1.05, gain: 0.22 },
      ];

      notes.forEach(n => {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, now + n.start);

        // Envolvente de campana suave (chime)
        gainNode.gain.setValueAtTime(0.001, now + n.start);
        gainNode.gain.linearRampToValueAtTime(n.gain, now + n.start + 0.04);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);

        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        osc.start(now + n.start);
        osc.stop(now + n.start + n.dur);
      });
    } catch (e) {
      console.warn('Audio bloqueado por navegador:', e);
    }
  };

  // ---------------------------------------------------------------------------
  // Notificación Sonora: VEHÍCULO NO AUTORIZADO / ALERTA (Audio Acceso Denegado MP3)
  // ---------------------------------------------------------------------------
  const playAlertSound = () => {
    try {
      const audioUrl = '/assets/Acceso denegado_ efecto de sonido.mp3';
      const audio = new Audio(audioUrl);
      audio.volume = 1.0;
      audio.play().catch(() => {
        const fallbackAudio = new Audio('/acceso_denegado.mp3');
        fallbackAudio.volume = 1.0;
        fallbackAudio.play().catch(err => console.warn('Audio bloqueado por navegador:', err));
      });
    } catch (e) {
      console.warn('Error al reproducir audio de acceso denegado:', e);
    }
  };

  const limpiarHistorial = async () => {
    if (window.confirm('¿Deseas purgar todas las capturas y dejar el feed completamente en 0?')) {
      try {
        await api.delete('/detecciones/limpiar');
        setDetecciones([]);
        setStats({
          total_hoy: 0,
          autorizados_hoy: 0,
          alertas_hoy: 0,
          no_reconocidos_hoy: 0,
          pendientes_hoy: 0
        });
        setAlertaActiva(null);
      } catch (e) {
        alert('Error al limpiar historial.');
      }
    }
  };

  const eliminarDeteccion = async (id: number) => {
    try {
      await api.delete(`/detecciones/${id}`);
      setDetecciones(prev => prev.filter(d => d.id !== id));
      setIngresoRecientes(prev => prev.filter(ing => ing.id !== id));
      setAlertaActiva(prev => (prev?.id === id ? null : prev));
      setStats(prev => ({
        ...prev,
        total_hoy: Math.max(0, prev.total_hoy - 1)
      }));
    } catch (e) {
      console.warn('Fallo al eliminar en backend, aplicando borrado local:', e);
      setDetecciones(prev => prev.filter(d => d.id !== id));
      setIngresoRecientes(prev => prev.filter(ing => ing.id !== id));
      setAlertaActiva(prev => (prev?.id === id ? null : prev));
    }
  };

  const abrirValidador = (item: DeteccionItem) => {
    setSelectedDeteccion(item);
    const existing = item.validado_manualmente 
      ? (item.placa_validada || '') 
      : (item.placa_reconocida || item.placa || '');
    // Si la placa es un marcador temporal, iniciar en blanco para comodidad del operador
    const cleanInitial = (existing === 'SIN_RECONOCER' || existing === 'NO_LEGIBLE' || existing === 'PROCESANDO' || existing === 'PROCESANDO...') 
      ? '' 
      : existing;
    setPlacaManual(cleanInitial);

    // Deducir o cargar tipo de vehículo
    const tipo = (item.tipo_vehiculo || '').toLowerCase();
    if (tipo.includes('moto')) {
      setTipoVehiculoManual('Motocicleta');
    } else if (tipo.includes('camioneta')) {
      setTipoVehiculoManual('Camioneta');
    } else if (tipo.includes('camión') || tipo.includes('camion')) {
      setTipoVehiculoManual('Camión');
    } else if (tipo.includes('bus')) {
      setTipoVehiculoManual('Bus');
    } else {
      setTipoVehiculoManual('Automóvil');
    }

    setShowValidador(true);
  };

  const guardarValidacion = async () => {
    if (!selectedDeteccion || !placaManual.trim()) return;

    try {
      const cleanPlaca = placaManual.toUpperCase().trim().replace(/[^A-Z0-9-]/g, '');
      const res = await api.post(`/detecciones/validar/${selectedDeteccion.id}`, {
        placa_validada: cleanPlaca,
        tipo_vehiculo: tipoVehiculoManual
      });

      if (res.data?.deteccion) {
        const detActualizada = res.data.deteccion;
        setDetecciones(prev => prev.map(d => d.id === detActualizada.id ? detActualizada : d));
      }
      setShowValidador(false);
      setSelectedDeteccion(null);

      // Sincronizar de inmediato la tabla de ingresos recientes y las estadísticas
      fetchRecientes();
      fetchStats();
    } catch (error: any) {
      alert(error.response?.data?.error || 'Error al validar placa.');
    }
  };

  const renderEstadoBadge = (det: DeteccionItem) => {
    if (det.validado_manualmente) {
      if (det.estado_validacion === 'autorizado') {
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: 'white', backgroundColor: 'var(--success)', padding: '3px 8px', borderRadius: '4px' }}>
            <CheckCircle size={12} />
            AUTORIZADO
          </span>
        );
      }
      if (det.estado_validacion === 'alerta' || det.alerta_detectada) {
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: 'white', backgroundColor: 'var(--alert-critica)', padding: '3px 8px', borderRadius: '4px' }}>
            <ShieldAlert size={12} />
            LISTA NEGRA
          </span>
        );
      }
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: '#0284c7', backgroundColor: 'rgba(2,132,199,0.12)', border: '1px solid rgba(2,132,199,0.25)', padding: '3px 8px', borderRadius: '4px' }}>
          <CheckCircle size={12} />
          VALIDADO MANUAL
        </span>
      );
    }

    if (det.estado_procesamiento === 'pendiente_ocr') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: 'white', backgroundColor: 'var(--accent-blue)', padding: '3px 8px', borderRadius: '4px', animation: 'pulse 1.5s infinite' }}>
          <Loader2 size={12} className="animate-spin" />
          ANALIZANDO PLACA...
        </span>
      );
    }

    if (det.estado_validacion === 'autorizado') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: 'white', backgroundColor: 'var(--success)', padding: '3px 8px', borderRadius: '4px' }}>
          <CheckCircle size={12} />
          AUTORIZADO
        </span>
      );
    }

    if (det.estado_validacion === 'alerta' || det.alerta_detectada) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: 'white', backgroundColor: 'var(--alert-critica)', padding: '3px 8px', borderRadius: '4px' }}>
          <ShieldAlert size={12} />
          LISTA NEGRA
        </span>
      );
    }

    if (det.estado_procesamiento === 'no_legible' || det.placa_reconocida === 'SIN_RECONOCER' || det.placa === 'SIN_RECONOCER') {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: '#d97706', backgroundColor: '#fef3c7', border: '1px solid #fde68a', padding: '3px 8px', borderRadius: '4px' }}>
          <HelpCircle size={12} />
          PENDIENTE REVISIÓN
        </span>
      );
    }

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)', backgroundColor: 'rgba(255,255,255,0.06)', padding: '3px 8px', borderRadius: '4px' }}>
        <HelpCircle size={12} />
        NO RECONOCIDO
      </span>
    );
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      padding: '24px 28px',
      maxWidth: '1750px',
      margin: '0 auto',
      width: '100%'
    }}>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 1. Métricas Superiores en Tiempo Real                               */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '18px' }}>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '14px', borderLeft: '4px solid var(--accent-blue)', minHeight: '80px' }}>
          <div style={{ padding: '10px', background: 'rgba(37,99,235,0.10)', borderRadius: '10px', color: '#2563eb', flexShrink: 0 }}>
            <Car size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '2px' }}>CAPTURAS HOY</div>
            <div style={{ fontSize: '24px', fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 }}>{stats.total_hoy || detecciones.length}</div>
          </div>
        </div>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '14px', borderLeft: '4px solid var(--success)', minHeight: '80px' }}>
          <div style={{ padding: '10px', background: 'rgba(22,163,74,0.10)', borderRadius: '10px', color: 'var(--success)', flexShrink: 0 }}>
            <UserCheck size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '2px' }}>AUTORIZADOS</div>
            <div style={{ fontSize: '24px', fontWeight: 900, color: 'var(--success)', lineHeight: 1 }}>{stats.autorizados_hoy || 0}</div>
          </div>
        </div>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '14px', borderLeft: '4px solid var(--alert-critica)', minHeight: '80px' }}>
          <div style={{ padding: '10px', background: 'rgba(239,68,68,0.10)', borderRadius: '10px', color: 'var(--alert-critica)', flexShrink: 0 }}>
            <ShieldAlert size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '2px' }}>ALERTAS / LISTA NEGRA</div>
            <div style={{ fontSize: '24px', fontWeight: 900, color: 'var(--alert-critica)', lineHeight: 1 }}>{stats.alertas_hoy || 0}</div>
          </div>
        </div>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '14px', borderLeft: `4px solid ${anprStatus.online ? '#0284c7' : 'var(--alert-media)'}`, minHeight: '80px' }}>
          <div style={{ padding: '10px', background: 'rgba(2,132,199,0.10)', borderRadius: '10px', color: '#0284c7', flexShrink: 0 }}>
            <Cpu size={22} />
          </div>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '2px' }}>PIPELINE DOS FASES</div>
            <div style={{ fontSize: '12px', fontWeight: 800, color: anprStatus.online ? 'var(--success)' : 'var(--alert-media)', display: 'flex', alignItems: 'center', gap: '6px', lineHeight: 1.2 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: anprStatus.online ? 'var(--success)' : 'var(--alert-media)', display: 'inline-block', flexShrink: 0 }} />
              {anprStatus.online ? `Activo — ${anprStatus.fps} FPS` : 'Desconectado'}
            </div>
          </div>
        </div>

      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 2. Grid Principal: Video Monitor Directo (Izq) + Feed en Vivo (Der) */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '7fr 5fr', gap: '20px', alignItems: 'start' }}>

        {/* COLUMNA IZQUIERDA: Monitor de Video en Vivo sin Latencia */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          <div className="glass shadow-premium" style={{ padding: '20px', borderRadius: '14px', border: '1px solid var(--border-color)' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Activity size={18} color="var(--accent-cyan)" />
                <h2 style={{ fontSize: '16px', fontWeight: 800 }}>
                  {activeChannelInfo ? `Monitoreo Canal RTSP: ${activeChannelInfo.nombre}` : 'Monitoreo de Video en Tiempo Real'}
                </h2>
              </div>

              {/* Controles INDEPENDIENTES por Submenú / Canal */}
              {activeChannelInfo ? (
                /* CASO A: Controles Exclusivos para Canal RTSP Seleccionado (Submenú) */
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '4px 8px', border: '1px solid var(--border-color)' }}>
                    {videoMode === 'stream' ? (
                      <>
                        <span style={{ fontSize: '11px', fontWeight: 800, color: '#38bdf8', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#38bdf8', animation: 'pulse 1s infinite' }} />
                          RTSP EN VIVO ({activeChannelInfo.nombre})
                        </span>
                        <button
                          onClick={() => setStreamKey(Date.now())}
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '11px', gap: '4px' }}
                          title="Refrescar Flujo RTSP"
                        >
                          <RefreshCw size={12} />
                        </button>
                        <button
                          onClick={stopServerStream}
                          style={{
                            padding: '4px 10px',
                            fontSize: '11px',
                            fontWeight: 800,
                            borderRadius: '6px',
                            border: 'none',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            backgroundColor: 'rgba(239, 68, 68, 0.85)',
                            color: '#fff',
                            transition: 'var(--transition-smooth)'
                          }}
                          title="Apagar Cámara RTSP"
                        >
                          <Square size={11} />
                          Apagar Cámara RTSP
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={startServerStream}
                        style={{
                          padding: '5px 14px',
                          fontSize: '11px',
                          fontWeight: 800,
                          borderRadius: '6px',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          backgroundColor: 'rgba(56, 189, 248, 0.2)',
                          color: '#38bdf8',
                          transition: 'var(--transition-smooth)'
                        }}
                        title="Encender Cámara RTSP"
                      >
                        <Play size={12} />
                        Encender Cámara RTSP
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                /* CASO B: Controles del Canal Principal (Webcam Local vs Stream Servidor) */
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  {/* 1. Control Stream Servidor / Docker */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '3px 4px', border: '1px solid var(--border-color)' }}>
                    {videoMode === 'stream' ? (
                      <>
                        <span style={{ fontSize: '11px', fontWeight: 800, color: '#38bdf8', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#38bdf8', animation: 'pulse 1.2s infinite' }} />
                          Stream Servidor (Activo)
                        </span>
                        <button
                          onClick={() => setStreamKey(Date.now())}
                          className="btn btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '11px', gap: '4px' }}
                          title="Refrescar Stream"
                        >
                          <RefreshCw size={12} />
                        </button>
                        <button
                          onClick={stopServerStream}
                          style={{
                            padding: '4px 10px',
                            fontSize: '11px',
                            fontWeight: 800,
                            borderRadius: '6px',
                            border: 'none',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            backgroundColor: 'rgba(239, 68, 68, 0.85)',
                            color: '#fff',
                            transition: 'var(--transition-smooth)'
                          }}
                          title="Apagar Stream del Servidor"
                        >
                          <Square size={11} />
                          Apagar
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={startServerStream}
                        style={{
                          padding: '5px 12px',
                          fontSize: '11px',
                          fontWeight: 800,
                          borderRadius: '6px',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          backgroundColor: 'rgba(56, 189, 248, 0.15)',
                          color: '#38bdf8',
                          transition: 'var(--transition-smooth)'
                        }}
                      >
                        <Play size={12} />
                        Stream Servidor
                      </button>
                    )}
                  </div>

                  {/* 2. Control Webcam Local */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '3px 4px', border: '1px solid var(--border-color)' }}>
                    {videoMode === 'webcam' ? (
                      <>
                        <span style={{ fontSize: '11px', fontWeight: 800, color: '#4ade80', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#4ade80', animation: 'pulse 1.2s infinite' }} />
                          Webcam Local (Activa)
                        </span>
                        <button
                          onClick={stopWebcam}
                          style={{
                            padding: '4px 10px',
                            fontSize: '11px',
                            fontWeight: 800,
                            borderRadius: '6px',
                            border: 'none',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            backgroundColor: 'rgba(239, 68, 68, 0.85)',
                            color: '#fff',
                            transition: 'var(--transition-smooth)'
                          }}
                          title="Apagar Webcam Local"
                        >
                          <Square size={11} />
                          Apagar
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={startWebcam}
                        disabled={webcamLoading}
                        style={{
                          padding: '5px 12px',
                          fontSize: '11px',
                          fontWeight: 800,
                          borderRadius: '6px',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          backgroundColor: 'rgba(74, 222, 128, 0.15)',
                          color: '#4ade80',
                          transition: 'var(--transition-smooth)'
                        }}
                      >
                        <Camera size={12} />
                        {webcamLoading ? 'Iniciando...' : 'Webcam Local'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Banner de Canal RTSP Seleccionado */}
            {activeChannelInfo && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 16px',
                  backgroundColor: 'rgba(2, 132, 199, 0.15)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  borderRadius: '8px',
                  marginBottom: '14px',
                  boxShadow: '0 2px 10px rgba(2, 132, 199, 0.15)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', backgroundColor: '#38bdf8', animation: 'pulse 1s infinite', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: '12px', fontWeight: 900, color: '#f0f9ff', letterSpacing: '0.3px' }}>
                      CANAL RTSP SELECCIONADO: {activeChannelInfo.nombre}
                    </div>
                    <div style={{ fontSize: '11px', color: '#7dd3fc', opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      URL: {activeChannelInfo.rtsp_url} | IP: {activeChannelInfo.ip || 'Red Local'}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    navigate('/');
                    fetch(`${ANPR_URL}/api/camera/switch`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        camera_id: 1,
                        source_type: 'webcam',
                        nombre: 'Cámara Principal / Webcam'
                      })
                    }).then(() => {
                      setStreamKey(Date.now());
                    }).catch(() => {});
                  }}
                  className="btn"
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '5px 12px',
                    backgroundColor: '#1e293b',
                    color: '#e2e8f0',
                    border: '1px solid #475569',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    flexShrink: 0
                  }}
                >
                  Volver a Cámara Principal
                </button>
              </div>
            )}

            {/* Contenedor del Monitor de Video */}
            <div style={{ borderRadius: '10px', overflow: 'hidden', background: '#000', border: '1px solid var(--border-color)', position: 'relative', minHeight: '420px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              
              {/* ESTADO 1: WEBCAM LOCAL */}
              {videoMode === 'webcam' && (
                <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '420px' }}>
                  <video
                    ref={(el) => {
                      localVideoRef.current = el;
                      if (el && localStreamRef.current && el.srcObject !== localStreamRef.current) {
                        el.srcObject = localStreamRef.current;
                        el.play().catch(() => {});
                      }
                    }}
                    autoPlay
                    playsInline
                    muted
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', maxHeight: '520px', minHeight: '400px' }}
                  />

                  {/* Overlay Canvas Táctico en Tiempo Real (0ms Latencia) */}
                  <canvas
                    ref={overlayCanvasRef}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'none',
                    }}
                  />

                  {/* Badges superiores de la webcam */}
                  <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: 'white', backgroundColor: 'rgba(22, 163, 74, 0.9)', padding: '4px 10px', borderRadius: '6px', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#fff', animation: 'pulse 1s infinite' }} />
                      WEBCAM LOCAL ACTIVA • PROCESANDO IA
                    </span>
                    {webcamLatency > 0 && (
                      <span style={{ fontSize: '11px', fontWeight: 700, color: 'white', backgroundColor: 'rgba(15, 23, 42, 0.85)', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)' }}>
                        LATENCIA: {webcamLatency}ms {webcamFps > 0 ? `| ${webcamFps} FPS` : ''}
                      </span>
                    )}
                  </div>

                  {/* Botón rápido de apagado en esquina superior derecha */}
                  <div style={{ position: 'absolute', top: 12, right: 12 }}>
                    <button
                      onClick={stopWebcam}
                      className="btn"
                      style={{ padding: '4px 10px', fontSize: '11px', backgroundColor: 'rgba(239, 68, 68, 0.9)', color: '#fff', borderRadius: '6px' }}
                    >
                      <Square size={12} style={{ marginRight: 4 }} /> Apagar Webcam
                    </button>
                  </div>

                  {webcamError && (
                    <div style={{ position: 'absolute', bottom: 16, background: 'rgba(239, 68, 68, 0.9)', color: 'white', padding: '8px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 700 }}>
                      {webcamError}
                    </div>
                  )}

                  <canvas ref={localCanvasRef} style={{ display: 'none' }} />
                </div>
              )}

              {/* ESTADO DE TRANSICIÓN: CONMUTACIÓN INTELIGENTE DE CANAL */}
              {isSwitchingChannel && (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', minHeight: '420px', justifyContent: 'center' }}>
                  <div style={{ width: '64px', height: '64px', borderRadius: '50%', backgroundColor: 'rgba(56, 189, 248, 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(56, 189, 248, 0.35)' }}>
                    <RefreshCw size={30} className="animate-spin" style={{ color: '#38bdf8' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 800, color: 'white', marginBottom: '6px' }}>
                      {activeChannelInfo ? `Conmutando a Canal RTSP: ${activeChannelInfo.nombre}` : 'Conmutando a Canal Principal (Webcam)...'}
                    </div>
                    <div style={{ fontSize: '12px', maxWidth: '420px', color: 'var(--text-secondary)' }}>
                      {activeChannelInfo?.rtsp_url ? `Estableciendo enlace de ultra-baja latencia con ${activeChannelInfo.rtsp_url}` : 'Inicializando dispositivo de captura local...'}
                    </div>
                  </div>
                </div>
              )}

              {/* ESTADO 2: STREAM SERVIDOR / DOCKER / RTSP */}
              {!isSwitchingChannel && videoMode === 'stream' && (
                !streamError ? (
                  <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '420px' }}>
                    {/* Renderizador Canvas HTML5 Ultra-Baja Latencia (< 20ms) */}
                    <canvas
                      ref={streamCanvasRef}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        display: streamUseFallback ? 'none' : 'block',
                        maxHeight: '520px',
                        minHeight: '400px',
                      }}
                    />

                    {/* Respaldo Automático HTTP MJPEG en caso de indisponibilidad de WebSocket */}
                    {streamUseFallback && (
                      <img
                        key={streamKey}
                        src={`${ANPR_URL}/debug/stream?t=${streamKey}`}
                        alt="Stream ANPR en Vivo"
                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', maxHeight: '520px', minHeight: '400px' }}
                        onError={() => setStreamError(true)}
                      />
                    )}

                    <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: 'white', backgroundColor: activeChannelInfo ? 'rgba(2, 132, 199, 0.9)' : 'rgba(16, 185, 129, 0.9)', padding: '4px 10px', borderRadius: '6px', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#fff', animation: 'pulse 1s infinite' }} />
                        {activeChannelInfo ? `CANAL RTSP: ${activeChannelInfo.nombre}` : 'STREAM SERVIDOR • PROTOCOLO ITS'}
                      </span>
                      {!streamUseFallback && wsConnected && (
                        <span style={{ fontSize: '11px', fontWeight: 800, color: '#38bdf8', backgroundColor: 'rgba(15, 23, 42, 0.9)', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(56, 189, 248, 0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          ⚡ CERO LATENCIA {streamWebFps > 0 ? `| ${streamWebFps} FPS WEB` : ''}
                        </span>
                      )}
                      {streamUseFallback && (
                        <span style={{ fontSize: '11px', fontWeight: 700, color: '#f59e0b', backgroundColor: 'rgba(15, 23, 42, 0.9)', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(245, 158, 11, 0.4)' }}>
                          MODO RESPALDO (HTTP MJPEG)
                        </span>
                      )}
                    </div>

                    {/* Controles flotantes en stream */}
                    <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: '6px' }}>
                      {!activeChannelInfo && (
                        <button
                          onClick={startWebcam}
                          className="btn"
                          style={{ padding: '4px 10px', fontSize: '11px', backgroundColor: 'rgba(56, 189, 248, 0.85)', color: '#fff', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', gap: '4px' }}
                          title="Activar Webcam Local"
                        >
                          <Camera size={12} /> Activar Webcam
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setStreamUseFallback(false);
                          setStreamKey(Date.now());
                        }}
                        className="btn"
                        style={{ padding: '4px 8px', fontSize: '11px', backgroundColor: 'rgba(15, 23, 42, 0.85)', color: '#fff', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.2)' }}
                        title="Refrescar Stream"
                      >
                        <RefreshCw size={12} />
                      </button>
                      <button
                        onClick={stopServerStream}
                        className="btn"
                        style={{ padding: '4px 10px', fontSize: '11px', backgroundColor: 'rgba(239, 68, 68, 0.9)', color: '#fff', borderRadius: '6px' }}
                      >
                        <Square size={12} style={{ marginRight: 4 }} /> {activeChannelInfo ? 'Apagar Cámara RTSP' : 'Apagar Stream'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
                    <Video size={42} style={{ margin: '0 auto 12px', opacity: 0.5, color: 'var(--alert-media)' }} />
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'white', marginBottom: '6px' }}>
                      Conectando con el Agente ANPR...
                    </div>
                    <div style={{ fontSize: '12px', maxWidth: '380px', margin: '0 auto 16px' }}>
                      El flujo de video no responde en <code>{ANPR_URL}</code>.
                      <br />
                      Puedes reintentar la conexión:
                    </div>
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                      <button onClick={() => { setStreamError(false); setStreamKey(Date.now()); }} className="btn btn-primary" style={{ fontSize: '12px' }}>
                        <RefreshCw size={14} style={{ marginRight: 6 }} /> Reintentar Flujo
                      </button>
                      {!activeChannelInfo && (
                        <button onClick={startWebcam} className="btn btn-secondary" style={{ fontSize: '12px' }}>
                          <Camera size={14} style={{ marginRight: 6 }} /> Usar Webcam Local
                        </button>
                      )}
                    </div>
                  </div>
                )
              )}

              {/* ESTADO 3: MONITOR APAGADO / STANDBY */}
              {!isSwitchingChannel && videoMode === 'off' && (
                <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
                  <div style={{ width: '60px', height: '60px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)' }}>
                    <VideoOff size={30} style={{ opacity: 0.6, color: 'var(--text-secondary)' }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: 'white', marginBottom: '4px' }}>
                      {activeChannelInfo ? `Cámara RTSP (${activeChannelInfo.nombre}) en Pausa` : 'Monitor de Video Apagado'}
                    </div>
                    <div style={{ fontSize: '12px', maxWidth: '400px', color: 'var(--text-secondary)' }}>
                      {activeChannelInfo
                        ? 'El consumo de la cámara RTSP está pausado para optimizar ancho de banda de red y recursos de CPU.'
                        : 'El consumo de video está pausado para optimizar recursos de red y CPU.'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
                    {activeChannelInfo ? (
                      <button
                        onClick={startServerStream}
                        className="btn btn-primary"
                        style={{ fontSize: '12px', padding: '8px 16px', gap: '6px', backgroundColor: '#0284c7' }}
                      >
                        <Play size={14} />
                        Encender Cámara RTSP ({activeChannelInfo.nombre})
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={startServerStream}
                          className="btn btn-primary"
                          style={{ fontSize: '12px', padding: '8px 16px', gap: '6px' }}
                        >
                          <Play size={14} />
                          Encender Stream Servidor
                        </button>
                        <button
                          onClick={startWebcam}
                          className="btn btn-secondary"
                          style={{ fontSize: '12px', padding: '8px 16px', gap: '6px' }}
                        >
                          <Camera size={14} />
                          Encender Webcam Local
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

            </div>

            {/* Barra inferior de Estado */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', fontSize: '11px', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '8px' }}>
              <span>
                Fuente Activa:{' '}
                {videoMode === 'off'
                  ? (activeChannelInfo ? `Cámara RTSP ${activeChannelInfo.nombre} (Apagada / Standby)` : 'Video en Pausa (Recursos Optimizados)')
                  : videoMode === 'webcam'
                  ? 'Webcam Local del Operador (Procesamiento en Vivo)'
                  : activeChannelInfo
                  ? `Cámara RTSP: ${activeChannelInfo.nombre} (${activeChannelInfo.rtsp_url})`
                  : 'Stream Servidor / Protocolo ITS'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  onClick={playAuthorizedSound}
                  className="btn btn-secondary"
                  title="Probar sonido de vehículo autorizado"
                  style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '4px' }}
                >
                  <Volume2 size={12} /> Test Autorizado
                </button>
                <button
                  type="button"
                  onClick={playAlertSound}
                  className="btn btn-secondary"
                  title="Probar sonido de alerta / lista negra"
                  style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--alert-critica)', display: 'flex', alignItems: 'center', gap: '4px' }}
                >
                  <AlertOctagon size={12} /> Test Alerta
                </button>
                <button
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className="btn btn-secondary"
                  style={{ padding: '4px 10px', fontSize: '11px', gap: '6px' }}
                >
                  {soundEnabled ? <Volume2 size={14} color="var(--success)" /> : <VolumeX size={14} color="var(--alert-critica)" />}
                  {soundEnabled ? 'Alarma Sonora Activa' : 'Alarma Silenciada'}
                </button>
              </div>
            </div>

          </div>

          {/* Banner de Acceso No Autorizado / Alerta Activa */}
          {alertaActiva && (
            <div
              className="glass alert-pulse animate-fade-in"
              style={{
                padding: '16px 20px',
                borderRadius: '12px',
                backgroundColor: 'rgba(239, 68, 68, 0.14)',
                border: '2px solid var(--alert-critica)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <div
                  style={{
                    background: '#ef4444',
                    color: 'white',
                    width: '42px',
                    height: '42px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 0 12px rgba(239, 68, 68, 0.5)',
                  }}
                >
                  <AlertOctagon size={24} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 900, color: 'var(--alert-critica)', fontSize: '15px' }}>
                      ¡ALERTA DE ACCESO NO AUTORIZADO!
                    </span>
                    <span
                      style={{
                        background: '#0f172a',
                        color: '#ffffff',
                        fontSize: '13px',
                        fontWeight: 900,
                        padding: '2px 9px',
                        borderRadius: '4px',
                        letterSpacing: '1px',
                        border: '1px solid #ef4444',
                      }}
                    >
                      {alertaActiva.placa_reconocida || alertaActiva.placa}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                    {alertaActiva.alerta_motivo || 'Vehículo no autorizado'} • Hora: {new Date(alertaActiva.fecha_hora_ingreso || alertaActiva.fecha_hora || Date.now()).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => setModalAlertaOpen(true)}
                  className="btn"
                  style={{
                    background: '#dc2626',
                    color: '#ffffff',
                    fontWeight: 800,
                    fontSize: '12px',
                    padding: '9px 16px',
                    borderRadius: '8px',
                    border: 'none',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(220, 38, 38, 0.45)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <ShieldAlert size={15} />
                  Ver Protocolo para Guardia
                </button>
                <button
                  onClick={() => { setAlertaActiva(null); setModalAlertaOpen(false); }}
                  className="btn"
                  style={{ padding: '7px 11px', background: 'rgba(0,0,0,0.06)', color: 'var(--text-secondary)', fontSize: '11px', border: '1px solid var(--border-color)', borderRadius: '6px' }}
                >
                  Cerrar
                </button>
              </div>
            </div>
          )}

        </div>

        {/* COLUMNA DERECHA: Feed de Ingresos en Vivo (Dos Fases) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>Registro de Ingresos (Dos Fases)</span>
            </h2>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={limpiarHistorial}
                className="btn"
                style={{ padding: '4px 10px', fontSize: '11px', color: '#dc2626', background: '#fee2e2', border: '1px solid #fca5a5', display: 'flex', alignItems: 'center', gap: '5px' }}
                title="Purgar capturas y limpiar feed"
              >
                <Trash2 size={12} />
                Limpiar Feed
              </button>
              <span style={{ fontSize: '11px', color: '#64748b', background: '#f1f5f9', padding: '3px 8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                En Vivo
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', maxHeight: '540px', paddingRight: '4px' }}>
            {detecciones.length === 0 ? (
              <div className="glass" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', borderRadius: '12px' }}>
                <Camera size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Esperando capturas fotográficas de la cámara...</div>
                <div style={{ fontSize: '11px', marginTop: '6px' }}>El sistema seleccionará el frame más nítido automáticamente.</div>
              </div>
            ) : (
              detecciones.map((det) => {
                const esAlerta = det.estado_validacion === 'alerta' || det.alerta_detectada;
                const esAutorizado = det.estado_validacion === 'autorizado';
                const esPendiente = det.estado_procesamiento === 'pendiente_ocr';

                const fotoVehiculo = det.ruta_imagen_ingreso || det.imagen_vehiculo_path;
                const fotoPlaca = det.ruta_imagen_placa || det.imagen_placa_path || fotoVehiculo;

                return (
                  <div
                    key={det.id}
                    className="glass shadow-premium animate-fade-in"
                    style={{
                      padding: '14px',
                      borderRadius: '10px',
                      borderLeft: `4px solid ${
                        esAlerta
                          ? 'var(--alert-critica)'
                          : esAutorizado
                          ? 'var(--success)'
                          : esPendiente
                          ? 'var(--accent-blue)'
                          : 'var(--border-color)'
                      }`,
                      display: 'grid',
                      gridTemplateColumns: '110px 1fr',
                      gap: '14px',
                      transition: 'all 0.3s ease'
                    }}
                  >
                    {/* Miniatura: Foto del vehículo o recorte de placa */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div
                        onClick={() => setZoomImagen({
                          vehiculoUrl: getMediaUrl(det.ruta_imagen_ingreso || det.imagen_vehiculo_path || ''),
                          placaUrl: getMediaUrl(det.ruta_imagen_placa || det.imagen_placa_path || det.ruta_imagen_ingreso || det.imagen_vehiculo_path || ''),
                          placa: det.placa_reconocida || det.placa,
                          fecha: new Date(det.fecha_hora_ingreso || det.fecha_hora || Date.now()).toLocaleString('es-EC'),
                          propietario: det.propietario,
                          tipo_vehiculo: det.tipo_vehiculo,
                          confianza: det.confianza_ocr ? (det.confianza_ocr * 100).toFixed(1) : null,
                          estado: det.estado_validacion,
                          camara: det.camara_nombre,
                          tracking_id: det.tracking_id
                        })}
                        style={{ height: '70px', borderRadius: '6px', overflow: 'hidden', border: '1px solid #e2e8f0', background: '#121214', cursor: 'zoom-in', position: 'relative' }}
                        title="Clic para ver fotografía panorámica y placa con zoom profesional"
                      >
                        <img
                          src={getMediaUrl(fotoPlaca || fotoVehiculo)}
                          alt="Evidencia Fotográfica"
                          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                          onError={(e) => handleImageError(e, fotoPlaca || fotoVehiculo)}
                        />
                      </div>
                      <div style={{ fontSize: '9px', textAlign: 'center', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-around' }}>
                        <span>YOLO: {det.confianza_deteccion ? `${(det.confianza_deteccion * 100).toFixed(0)}%` : '88%'}</span>
                        {det.confianza_ocr ? (
                          <span style={{ color: '#0284c7', fontWeight: 700 }}>OCR: {(det.confianza_ocr * 100).toFixed(0)}%</span>
                        ) : (
                          <span>{esPendiente ? 'OCR: ⏳' : ''}</span>
                        )}
                      </div>
                    </div>

                    {/* Información del Ingreso */}
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <span style={{ fontSize: '17px', fontWeight: 900, color: esPendiente ? '#0284c7' : '#0f172a', letterSpacing: '0.5px' }}>
                            {det.validado_manualmente 
                              ? det.placa_validada 
                              : (det.placa_reconocida && det.placa_reconocida !== 'SIN_RECONOCER' && det.placa_reconocida !== 'NO_LEGIBLE' && det.placa_reconocida !== 'PROCESANDO'
                                  ? det.placa_reconocida 
                                  : (det.placa && det.placa !== 'SIN_RECONOCER' && det.placa !== 'NO_LEGIBLE' && det.placa !== 'PROCESANDO' 
                                      ? det.placa 
                                      : 'PLACA NO IDENTIFICADA'))}
                          </span>
                          {renderEstadoBadge(det)}
                        </div>

                        {esAutorizado && det.propietario && (
                          <div style={{ fontSize: '11px', color: 'var(--success)', marginBottom: '4px' }}>
                            ✓ {det.propietario} {det.departamento ? `(${det.departamento})` : ''}
                          </div>
                        )}

                        {esAlerta && (
                          <div style={{ fontSize: '11px', color: '#fca5a5', marginBottom: '4px', background: 'rgba(239,68,68,0.1)', padding: '3px 6px', borderRadius: '4px' }}>
                            ⚠️ {det.alerta_motivo || 'Coincidencia con Lista Negra'}
                          </div>
                        )}

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '10px', color: 'var(--text-secondary)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <MapPin size={11} />
                            <span>{det.camara_nombre || 'Acceso Principal'} {det.tracking_id !== undefined && det.tracking_id >= 0 ? `• Track #${det.tracking_id}` : ''}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Calendar size={11} />
                            <span>{new Date(det.fecha_hora_ingreso || det.fecha_hora || Date.now()).toLocaleTimeString()} - {new Date(det.fecha_hora_ingreso || det.fecha_hora || Date.now()).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' }}>
                        {det.validado_manualmente ? (
                          <button
                            onClick={() => abrirValidador(det)}
                            className="btn"
                            style={{
                              padding: '3px 9px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: 'rgba(16, 185, 129, 0.12)',
                              color: '#059669',
                              border: '1px solid rgba(16, 185, 129, 0.25)',
                              borderRadius: '5px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              cursor: 'pointer'
                            }}
                            title="Validado manualmente. Click para editar o corregir"
                          >
                            <CheckCircle size={11} />
                            Validado (Editar)
                          </button>
                        ) : (
                          <button
                            onClick={() => abrirValidador(det)}
                            className="btn"
                            style={{
                              padding: '3px 9px',
                              fontSize: '11px',
                              fontWeight: 600,
                              background: 'rgba(2, 132, 199, 0.12)',
                              color: '#0284c7',
                              border: '1px solid rgba(2, 132, 199, 0.25)',
                              borderRadius: '5px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              cursor: 'pointer'
                            }}
                            title="Validar placa manualmente (incluso si no fue reconocida automáticamente)"
                          >
                            <Edit size={11} />
                            Validar
                          </button>
                        )}

                        {/* Botón Borrar Detección Individual */}
                        <button
                          onClick={() => eliminarDeteccion(det.id)}
                          className="btn"
                          style={{
                            padding: '3px 9px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background: 'rgba(239, 68, 68, 0.10)',
                            color: '#ef4444',
                            border: '1px solid rgba(239, 68, 68, 0.25)',
                            borderRadius: '5px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            cursor: 'pointer'
                          }}
                          title="Eliminar este cuadro de detección"
                        >
                          <Trash2 size={11} />
                          Borrar
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

        </div>

      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 3. Tabla Institucional de Ingresos Recientes                        */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div className="glass shadow-premium" style={{ borderRadius: '14px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
        {/* Encabezado de la tabla */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-color)',
          background: 'rgba(255,255,255,0.03)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Car size={18} color="var(--accent-cyan)" />
            <h2 style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '0.3px' }}>Registro de Ingresos — ECU 911</h2>
            <span style={{
              fontSize: '10px', fontWeight: 700, color: '#0284c7',
              background: 'rgba(2,132,199,0.10)', padding: '2px 8px',
              borderRadius: '20px', border: '1px solid rgba(2,132,199,0.2)'
            }}>EN VIVO</span>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            {ingresoRecientes.length} registro{ingresoRecientes.length !== 1 ? 's' : ''} recientes
          </span>
        </div>

        {/* Tabla */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'rgba(0,0,0,0.03)' }}>
                {[
                  'Fecha y Hora',
                  'Placa',
                  'Dueño / Vehiculo',
                  'Confianza',
                  'Fotografia de Placa'
                ].map(col => (
                  <th key={col} style={{
                    padding: '11px 18px',
                    textAlign: 'left',
                    fontSize: '10px',
                    fontWeight: 800,
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.7px',
                    textTransform: 'uppercase',
                    borderBottom: '1px solid var(--border-color)',
                    whiteSpace: 'nowrap'
                  }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ingresoRecientes.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{
                    textAlign: 'center', padding: '44px 20px',
                    color: 'var(--text-muted)', fontSize: '13px'
                  }}>
                    <Camera size={28} style={{ margin: '0 auto 8px', opacity: 0.3, display: 'block' }} />
                    Sin ingresos procesados registrados aun.
                  </td>
                </tr>
              ) : (
                ingresoRecientes.map((ing, idx) => {
                  const esAlerta = ing.estado_validacion === 'alerta' || !!ing.alerta_id;
                  const esAutorizado = ing.estado_validacion === 'autorizado';

                  const plateColor = esAlerta ? '#ef4444' : esAutorizado ? '#16a34a' : '#0284c7';

                  const rowBg = esAlerta
                    ? 'rgba(239,68,68,0.04)'
                    : esAutorizado
                    ? 'rgba(22,163,74,0.04)'
                    : idx % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.018)';

                  const confianzaPct = ing.confianza_ocr != null
                    ? (ing.confianza_ocr * 100).toFixed(1)
                    : ing.confianza_deteccion != null
                    ? (ing.confianza_deteccion * 100).toFixed(1)
                    : null;

                  const ts = new Date(ing.fecha_hora_ingreso);
                  const fechaFmt = ts.toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' });
                  const horaFmt = ts.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

                  const propietarioLabel = ing.propietario || '—';
                  const vehiculoLabel = ing.tipo_vehiculo || 'Vehiculo';

                  // Evidencia fotográfica de placa y vehículo
                  const detMatch = detecciones.find(d => d.tracking_id === ing.tracking_id || d.id === ing.id);
                  const rutaVehiculo = ing.ruta_imagen_ingreso || detMatch?.ruta_imagen_ingreso || detMatch?.imagen_vehiculo_path || '';
                  const rutaPlaca = ing.ruta_imagen_placa || detMatch?.ruta_imagen_placa || detMatch?.imagen_placa_path || rutaVehiculo;
                  const tieneFoto = Boolean(rutaVehiculo || rutaPlaca);

                  return (
                    <tr
                      key={ing.id}
                      style={{
                        background: rowBg,
                        borderBottom: '1px solid rgba(0,0,0,0.06)',
                        transition: 'background 0.15s'
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(2,132,199,0.05)')}
                      onMouseLeave={e => (e.currentTarget.style.background = rowBg)}
                    >
                      {/* Fecha y Hora */}
                      <td style={{ padding: '12px 18px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Calendar size={13} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
                          <div>
                            <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '13px', lineHeight: 1.2 }}>{horaFmt}</div>
                            <div style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{fechaFmt}</div>
                          </div>
                        </div>
                      </td>

                      {/* Placa */}
                      <td style={{ padding: '12px 18px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                          <span style={{
                            fontSize: '15px', fontWeight: 900,
                            color: plateColor, letterSpacing: '1.5px',
                            fontFamily: 'monospace'
                          }}>
                            {ing.placa && ing.placa !== 'SIN_RECONOCER' && ing.placa !== 'PROCESANDO' ? ing.placa : 'SIN RECONOCER'}
                          </span>
                          {esAlerta && (
                            <span style={{ fontSize: '9px', fontWeight: 800, color: '#ef4444', background: 'rgba(239,68,68,0.12)', padding: '1px 5px', borderRadius: '3px' }}>ALERTA</span>
                          )}
                          {esAutorizado && (
                            <span style={{ fontSize: '9px', fontWeight: 800, color: '#16a34a', background: 'rgba(22,163,74,0.12)', padding: '1px 5px', borderRadius: '3px' }}>OK</span>
                          )}
                          {ing.validado_manualmente ? (
                            <button
                              onClick={() => {
                                const detMatch = detecciones.find(d => d.id === ing.id) || {
                                  id: ing.id,
                                  placa: ing.placa,
                                  placa_reconocida: ing.placa,
                                  placa_validada: ing.placa,
                                  validado_manualmente: true,
                                  tipo_vehiculo: ing.tipo_vehiculo,
                                  ruta_imagen_ingreso: ing.ruta_imagen_ingreso,
                                  ruta_imagen_placa: ing.ruta_imagen_placa,
                                  fecha_hora_ingreso: ing.fecha_hora_ingreso,
                                  tracking_id: ing.tracking_id
                                } as DeteccionItem;
                                abrirValidador(detMatch);
                              }}
                              style={{
                                border: '1px solid rgba(16,185,129,0.3)',
                                background: 'rgba(16,185,129,0.1)',
                                color: '#059669',
                                fontSize: '9px',
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px'
                              }}
                              title="Validado manualmente. Click para editar"
                            >
                              <CheckCircle size={9} /> MANUAL
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                const detMatch = detecciones.find(d => d.id === ing.id) || {
                                  id: ing.id,
                                  placa: ing.placa,
                                  placa_reconocida: ing.placa,
                                  tipo_vehiculo: ing.tipo_vehiculo,
                                  ruta_imagen_ingreso: ing.ruta_imagen_ingreso,
                                  ruta_imagen_placa: ing.ruta_imagen_placa,
                                  fecha_hora_ingreso: ing.fecha_hora_ingreso,
                                  tracking_id: ing.tracking_id
                                } as DeteccionItem;
                                abrirValidador(detMatch);
                              }}
                              style={{
                                border: '1px solid #38bdf8',
                                background: '#f0f9ff',
                                color: '#0284c7',
                                fontSize: '10px',
                                fontWeight: 700,
                                padding: '2px 7px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px'
                              }}
                              title="Validar placa de este ingreso manualmente"
                            >
                              <Edit size={10} /> Validar
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Dueno / Vehiculo */}
                      <td style={{ padding: '12px 18px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', maxWidth: '200px' }}>
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {propietarioLabel}
                          </span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{vehiculoLabel}</span>
                        </div>
                      </td>

                      {/* Confianza */}
                      <td style={{ padding: '12px 18px', whiteSpace: 'nowrap' }}>
                        {confianzaPct !== null ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                            <div style={{ width: '40px', height: '5px', borderRadius: '3px', background: '#e2e8f0', overflow: 'hidden' }}>
                              <div style={{
                                height: '100%',
                                width: `${Math.min(parseFloat(confianzaPct), 100)}%`,
                                background: parseFloat(confianzaPct) >= 80 ? '#16a34a' : parseFloat(confianzaPct) >= 60 ? '#f59e0b' : '#ef4444',
                                borderRadius: '3px'
                              }} />
                            </div>
                            <span style={{
                              fontWeight: 700, fontSize: '12px',
                              color: parseFloat(confianzaPct) >= 80 ? '#16a34a' : parseFloat(confianzaPct) >= 60 ? '#f59e0b' : 'var(--text-secondary)'
                            }}>{confianzaPct}%</span>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>
                        )}
                      </td>

                      {/* Fotografia de Placa — miniatura clickeable con zoom dual */}
                      <td style={{ padding: '10px 18px' }}>
                        {tieneFoto ? (
                          <div
                            onClick={() => setZoomImagen({
                              vehiculoUrl: getMediaUrl(rutaVehiculo || rutaPlaca),
                              placaUrl: getMediaUrl(rutaPlaca || rutaVehiculo),
                              placa: ing.placa,
                              fecha: `${fechaFmt} • ${horaFmt}`,
                              propietario: ing.propietario,
                              tipo_vehiculo: ing.tipo_vehiculo,
                              confianza: confianzaPct,
                              estado: ing.estado_validacion,
                              camara: ing.camara_nombre,
                              tracking_id: ing.tracking_id
                            })}
                            title="Clic para ver fotografia panorámica y placa con zoom profesional"
                            style={{
                              width: '82px', height: '48px',
                              borderRadius: '6px', overflow: 'hidden',
                              border: `2px solid ${esAlerta ? '#fca5a5' : esAutorizado ? '#86efac' : '#e2e8f0'}`,
                              background: '#121214',
                              cursor: 'zoom-in',
                              position: 'relative',
                              flexShrink: 0,
                              transition: 'transform 0.15s, box-shadow 0.15s'
                            }}
                            onMouseEnter={e => {
                              (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.08)';
                              (e.currentTarget as HTMLDivElement).style.boxShadow = '0 6px 20px rgba(0,0,0,0.25)';
                            }}
                            onMouseLeave={e => {
                              (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)';
                              (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                            }}
                          >
                            <img
                              src={getMediaUrl(rutaPlaca || rutaVehiculo)}
                              alt={`Placa ${ing.placa}`}
                              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#09090b' }}
                              onError={e => {
                                const el = e.currentTarget as HTMLImageElement;
                                if (rutaVehiculo && el.src !== getMediaUrl(rutaVehiculo)) {
                                  el.src = getMediaUrl(rutaVehiculo);
                                } else {
                                  el.style.display = 'none';
                                }
                              }}
                            />
                            {/* Lupa overlay */}
                            <div style={{
                              position: 'absolute', inset: 0,
                              background: 'rgba(0,0,0,0)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              transition: 'background 0.15s', borderRadius: '4px'
                            }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.38)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,0,0,0)')}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.95 }}>
                                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                              </svg>
                            </div>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Sin foto</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 4. Modal de Zoom Profesional — Doble Panel con Wheel-Zoom           */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {zoomImagen && (
        <DualZoomModal
          data={zoomImagen}
          onClose={() => setZoomImagen(null)}
        />
      )}

      {/* Modal de Validacion Manual */}
      {showValidador && selectedDeteccion && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.65)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: '20px'
        }}>
          <div
            className="glass shadow-premium"
            style={{
              width: '100%',
              maxWidth: '480px',
              borderRadius: '12px',
              padding: '24px',
              border: '1px solid #e2e8f0',
              backgroundColor: '#ffffff'
            }}
          >
            <h3 style={{ fontSize: '16px', fontWeight: 800, marginBottom: '16px', color: '#0f172a' }}>
              Validación Manual de Captura ANPR
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid #e2e8f0', height: '120px', background: '#0f172a' }}>
                  <img
                    src={getMediaUrl(selectedDeteccion.ruta_imagen_ingreso || selectedDeteccion.imagen_vehiculo_path)}
                    alt="Vehículo Foto"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                    onError={(e) => handleImageError(e, selectedDeteccion.ruta_imagen_ingreso || selectedDeteccion.imagen_vehiculo_path)}
                  />
                </div>
                <div style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)', height: '120px', background: '#0b1329' }}>
                  <img
                    src={getMediaUrl(selectedDeteccion.ruta_imagen_placa || selectedDeteccion.imagen_placa_path || selectedDeteccion.ruta_imagen_ingreso)}
                    alt="Placa Recorte"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                    onError={(e) => handleImageError(e, selectedDeteccion.ruta_imagen_placa || selectedDeteccion.imagen_placa_path || selectedDeteccion.ruta_imagen_ingreso)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Corregir / Asignar Placa (Formato Ecuador):
                  </label>
                  <input
                    type="text"
                    className="input"
                    value={placaManual}
                    onChange={(e) => setPlacaManual(e.target.value)}
                    placeholder="Ej. PBA-1234 o PB-123A"
                    style={{ textTransform: 'uppercase', fontSize: '18px', fontWeight: 900, textAlign: 'center', letterSpacing: '2px', width: '100%' }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', display: 'block' }}>
                    Lectura automática: <strong>{selectedDeteccion.placa_reconocida || selectedDeteccion.placa || 'No detectada'}</strong>
                  </span>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Tipo de Vehículo:
                  </label>
                  <select
                    className="input"
                    value={tipoVehiculoManual}
                    onChange={(e) => setTipoVehiculoManual(e.target.value)}
                    style={{ fontSize: '13px', fontWeight: 600, padding: '8px 12px', width: '100%', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                  >
                    <option value="Automóvil">🚗 Automóvil (Placa 3 letras + 4 dígitos)</option>
                    <option value="Motocicleta">🏍️ Motocicleta (Placa 2 letras + dígitos)</option>
                    <option value="Camioneta">🛻 Camioneta</option>
                    <option value="Camión">🚚 Camión / Transporte Pesado</option>
                    <option value="Bus">🚌 Bus / Colectivo</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowValidador(false)} className="btn btn-secondary">
                  Cancelar
                </button>
                <button onClick={guardarValidacion} className="btn btn-primary">
                  Guardar Validación
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Acceso No Autorizado con Fondo Parpadeante Suave e Indicaciones para Guardia */}
      <UnauthorizedAccessModal
        isOpen={modalAlertaOpen && !!alertaActiva}
        onClose={() => setModalAlertaOpen(false)}
        data={alertaActiva}
        onSilenceAudio={() => setSoundEnabled(prev => !prev)}
        isAudioMuted={!soundEnabled}
      />

    </div>
  );
};

export default Dashboard;
