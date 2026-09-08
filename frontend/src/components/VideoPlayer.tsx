import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Camera, CameraOff, RefreshCw } from 'lucide-react';

interface VideoPlayerProps {
  streamUrl: string;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ streamUrl }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnectCount, setReconnectCount] = useState(0);

  useEffect(() => {
    let hls: Hls | null = null;
    const video = videoRef.current;
    
    if (!video) return;

    const initPlayer = () => {
      setLoading(true);
      setError(null);

      // Usar Hls.js si el navegador no soporta HLS nativamente
      if (Hls.isSupported()) {
        hls = new Hls({
          manifestLoadingTimeOut: 4000,
          manifestLoadingMaxRetry: 15,
          levelLoadingTimeOut: 4000,
          levelLoadingMaxRetry: 15,
          fragLoadingTimeOut: 6000,
          fragLoadingMaxRetry: 10,
          enableWorker: true,
          lowLatencyMode: true, // Optimizar para streaming en tiempo real
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setLoading(false);
          setError(null);
          video.play().catch(err => console.log('[HLS] Autoplay bloqueado por el navegador:', err));
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          console.warn('[HLS] Error de reproducción detectado:', data.type, data.details);
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                setError('Pérdida de conexión con el relay de la cámara (Reintentando...)');
                hls?.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                setError('Error en procesamiento de cuadros. Intentando recuperar...');
                hls?.recoverMediaError();
                break;
              default:
                setError('Error de conexión con la cámara. Reconectando...');
                destroyAndRetry();
                break;
            }
          }
        });
      } 
      // Soporte nativo para Safari o navegadores móviles
      else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', () => {
          setLoading(false);
          setError(null);
          video.play().catch(err => console.log('[HLS Nativo] Autoplay bloqueado:', err));
        });

        video.addEventListener('error', () => {
          setError('Error al cargar stream de video nativo. Reconectando...');
          destroyAndRetry();
        });
      } else {
        setError('Este navegador no soporta la reproducción de flujos HLS.');
        setLoading(false);
      }
    };

    const destroyAndRetry = () => {
      if (hls) {
        hls.destroy();
      }
      // Reintentar en 5 segundos
      setTimeout(() => {
        setReconnectCount(prev => prev + 1);
      }, 5000);
    };

    initPlayer();

    return () => {
      if (hls) {
        hls.destroy();
      }
    };
  }, [streamUrl, reconnectCount]);

  const handleManualReconnect = () => {
    setReconnectCount(prev => prev + 1);
  };

  return (
    <div 
      className="glass shadow-premium" 
      style={{
        position: 'relative',
        width: '100%',
        paddingTop: '56.25%', // Relación de aspecto 16:9
        borderRadius: '12px',
        overflow: 'hidden',
        border: '1px solid var(--border-color)',
        backgroundColor: '#000'
      }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover'
        }}
      />

      {/* Pantallas de Carga/Error */}
      {(loading || error) && (
        <div 
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: 'rgba(11, 19, 41, 0.85)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
            gap: '12px',
            color: 'white',
            padding: '20px',
            textAlign: 'center'
          }}
        >
          {loading && !error ? (
            <>
              <div 
                style={{
                  width: '40px',
                  height: '40px',
                  border: '3px solid rgba(58, 134, 200, 0.3)',
                  borderTop: '3px solid var(--accent-cyan)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }}
              />
              <style>{`
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              `}</style>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                <Camera size={18} />
                <span>Cargando stream de video en vivo (ECU 911)...</span>
              </div>
            </>
          ) : (
            <>
              <CameraOff size={36} color="var(--alert-critica)" />
              <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-secondary)' }}>{error}</span>
              <button 
                onClick={handleManualReconnect} 
                className="btn btn-secondary" 
                style={{ marginTop: '8px', padding: '6px 12px', fontSize: '12px' }}
              >
                <RefreshCw size={14} />
                Reconectar Manualmente
              </button>
            </>
          )}
        </div>
      )}

      {/* Marca de agua institucional */}
      <div 
        style={{
          position: 'absolute',
          top: '12px',
          left: '12px',
          zIndex: 5,
          background: 'rgba(11, 19, 41, 0.75)',
          padding: '6px 12px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.5px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          color: 'var(--text-primary)',
          borderLeft: '3px solid var(--accent-blue)'
        }}
      >
        <span style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: '#ef4444', borderRadius: '50%', animation: 'blink 1.5s infinite' }} />
        LIVE • CAM ACCESO PRINCIPAL
      </div>
      <style>{`
        @keyframes blink {
          0% { opacity: 0.2; }
          50% { opacity: 1; }
          100% { opacity: 0.2; }
        }
      `}</style>
    </div>
  );
};

export default VideoPlayer;
