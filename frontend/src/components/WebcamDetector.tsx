import React, { useEffect, useRef, useState } from 'react';

const ANPR_URL = import.meta.env.VITE_ANPR_URL || 'http://localhost:8000';

type Props = {
  autoStart?: boolean;
};

const WebcamDetector: React.FC<Props> = ({ autoStart = false }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState(1200);
  const [annotatedSrc, setAnnotatedSrc] = useState<string | null>(null);
  const [liveOverlaySrc, setLiveOverlaySrc] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (autoStart) {
      // try to start automatically (user must grant permission)
      start();
    }
    return () => stop();
  }, []);

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = s;
      if (videoRef.current) videoRef.current.srcObject = s;
      setRunning(true);
      timerRef.current = window.setInterval(captureAndSend, intervalMs);
    } catch (e) {
      alert('No se pudo acceder a la webcam. Verifica permisos del navegador.');
    }
  };

  const stop = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setRunning(false);
  };

  const captureAndSend = async () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = canvasRef.current || document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      try {
        const fd = new FormData();
        fd.append('file', blob, 'frame.jpg');
        const res = await fetch(`${ANPR_URL}/process/frame`, {
          method: 'POST',
          body: fd,
        });
        if (!res.ok) {
          console.warn('ANPR response not OK', await res.text());
          return;
        }
        const data = await res.json();
        if (data.annotated_image_base64) {
          const imageSrc = `data:image/jpeg;base64,${data.annotated_image_base64}`;
          setAnnotatedSrc(imageSrc);
          setLiveOverlaySrc(imageSrc);
        }
      } catch (e) {
        console.warn('Error enviando frame al ANPR:', e);
      }
    }, 'image/jpeg', 0.8);
  };

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ width: 360 }}>
        <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#000', width: '100%', aspectRatio: '4 / 3' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          {liveOverlaySrc && (
            <img
              src={liveOverlaySrc}
              alt="Detección ANPR en vivo"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
                pointerEvents: 'none',
                opacity: 0.92,
                background: 'transparent',
              }}
            />
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {!running ? (
            <button className="btn btn-primary" onClick={start}>Iniciar detección</button>
          ) : (
            <button className="btn btn-danger" onClick={stop}>Detener</button>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Intervalo (ms):
            <input type="number" value={intervalMs} onChange={e => setIntervalMs(parseInt(e.target.value || '1000'))} style={{ width: 80 }} />
          </label>
        </div>
      </div>

      <div style={{ width: 360 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Preview Anotado (ANPR)</div>
        <div style={{ borderRadius: 8, overflow: 'hidden', background: '#111', minHeight: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {annotatedSrc ? (
            <img src={annotatedSrc} style={{ width: '100%', display: 'block' }} />
          ) : (
            <div style={{ color: '#888' }}>Esperando primera detección...</div>
          )}
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
};

export default WebcamDetector;
