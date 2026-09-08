import React, { useEffect, useRef, useState } from 'react';

const WebcamCapture: React.FC<{ onCapture?: (blob: Blob) => void }> = ({ onCapture }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function start() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      } catch (e: any) {
        setError('No se pudo acceder a la webcam. Verifica permisos del navegador.');
      }
    }

    start();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const handleCapture = async () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      if (onCapture) onCapture(blob);
      // descargar captura localmente como fallback
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'capture.jpg';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/jpeg', 0.9);
  };

  return (
    <div>
      <div style={{ width: '100%', maxWidth: 640 }}>
        <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', borderRadius: 8, background: '#000' }} />
      </div>
      {error && <div style={{ color: '#f87171', marginTop: 8 }}>{error}</div>}
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={handleCapture}>Capturar foto</button>
      </div>
    </div>
  );
};

export default WebcamCapture;
