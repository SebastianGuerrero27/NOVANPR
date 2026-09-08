import React, { useState, useRef, useEffect } from 'react';
import { 
  X, 
  ZoomIn, 
  ZoomOut, 
  RotateCcw, 
  Camera, 
  Search, 
  ShieldCheck, 
  ShieldAlert, 
  HelpCircle,
  Calendar,
  User,
  Move
} from 'lucide-react';

export interface DualZoomData {
  vehiculoUrl: string;
  placaUrl: string;
  placa: string;
  fecha?: string;
  propietario?: string;
  tipo_vehiculo?: string;
  confianza?: string | number | null;
  estado?: string;
  camara?: string;
  tracking_id?: number;
}

interface DualZoomModalProps {
  data: DualZoomData;
  onClose: () => void;
}

interface ImageViewerProps {
  title: string;
  icon: React.ReactNode;
  imageUrl: string;
  alt: string;
  badgeText: string;
  fallbackUrl?: string;
}

const ImageViewer: React.FC<ImageViewerProps> = ({
  title,
  icon,
  imageUrl,
  alt,
  badgeText,
  fallbackUrl
}) => {
  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [imgError, setImgError] = useState<boolean>(false);
  const [currentSrc, setCurrentSrc] = useState<string>(imageUrl);

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentSrc(imageUrl);
    setImgError(false);
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [imageUrl]);

  const handleReset = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleZoomIn = () => {
    setScale(prev => Math.min(+(prev + 0.35).toFixed(2), 5.0));
  };

  const handleZoomOut = () => {
    setScale(prev => {
      const next = Math.max(+(prev - 0.35).toFixed(2), 1.0);
      if (next === 1) setPosition({ x: 0, y: 0 });
      return next;
    });
  };

  // Wheel zoom con soporte nativo de non-passive preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = 0.25;
      if (e.deltaY < 0) {
        setScale(prev => Math.min(+(prev + step).toFixed(2), 5.0));
      } else {
        setScale(prev => {
          const next = Math.max(+(prev - step).toFixed(2), 1.0);
          if (next === 1) setPosition({ x: 0, y: 0 });
          return next;
        });
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || scale <= 1) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    });
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleDoubleClick = () => {
    if (scale > 1) {
      handleReset();
    } else {
      setScale(2.2);
    }
  };

  const handleError = () => {
    if (fallbackUrl && currentSrc !== fallbackUrl) {
      setCurrentSrc(fallbackUrl);
    } else {
      setImgError(true);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: '#111113',
      borderRadius: '12px',
      border: '1px solid #27272a',
      overflow: 'hidden',
      height: '100%',
      minHeight: '440px',
      position: 'relative'
    }}>
      {/* Header del Panel */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 14px',
        background: '#18181b',
        borderBottom: '1px solid #27272a'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#0284c7' }}>{icon}</span>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#f4f4f5' }}>{title}</span>
          <span style={{
            fontSize: '10px',
            fontWeight: 800,
            color: '#a1a1aa',
            background: '#27272a',
            padding: '2px 6px',
            borderRadius: '4px'
          }}>
            {badgeText}
          </span>
        </div>

        {/* Toolbar de Controles de Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{
            fontSize: '11px',
            fontWeight: 700,
            color: scale > 1 ? '#38bdf8' : '#71717a',
            marginRight: '6px',
            minWidth: '42px',
            textAlign: 'right'
          }}>
            {Math.round(scale * 100)}%
          </span>

          <button
            onClick={handleZoomOut}
            disabled={scale <= 1}
            title="Reducir (Zoom Out)"
            style={{
              background: '#27272a',
              border: '1px solid #3f3f46',
              color: scale <= 1 ? '#52525b' : '#fafafa',
              borderRadius: '6px',
              padding: '5px 8px',
              cursor: scale <= 1 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <ZoomOut size={13} />
          </button>

          <button
            onClick={handleReset}
            disabled={scale === 1 && position.x === 0 && position.y === 0}
            title="Restablecer vista 100%"
            style={{
              background: '#27272a',
              border: '1px solid #3f3f46',
              color: '#fafafa',
              borderRadius: '6px',
              padding: '5px 8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <RotateCcw size={13} />
          </button>

          <button
            onClick={handleZoomIn}
            disabled={scale >= 5}
            title="Ampliar (Zoom In)"
            style={{
              background: '#27272a',
              border: '1px solid #3f3f46',
              color: scale >= 5 ? '#52525b' : '#fafafa',
              borderRadius: '6px',
              padding: '5px 8px',
              cursor: scale >= 5 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <ZoomIn size={13} />
          </button>
        </div>
      </div>

      {/* Viewport Interactivo */}
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'radial-gradient(circle, #18181b 0%, #09090b 100%)',
          cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
          userSelect: 'none'
        }}
      >
        {imgError || !currentSrc ? (
          <div style={{ textAlign: 'center', color: '#71717a', padding: '30px' }}>
            <Camera size={38} style={{ opacity: 0.3, margin: '0 auto 10px', display: 'block' }} />
            <div style={{ fontSize: '13px', fontWeight: 600 }}>Fotografía no disponible</div>
            <div style={{ fontSize: '11px', color: '#52525b', marginTop: '4px' }}>
              No se localizó el archivo en el almacenamiento multimedia
            </div>
          </div>
        ) : (
          <div
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.12s ease-out',
              maxWidth: '100%',
              maxHeight: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <img
              src={currentSrc}
              alt={alt}
              onError={handleError}
              draggable={false}
              style={{
                maxWidth: '100%',
                maxHeight: '56vh',
                objectFit: 'contain',
                display: 'block',
                borderRadius: '4px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
              }}
            />
          </div>
        )}

        {/* Indicador de ayuda al pie del visor */}
        <div style={{
          position: 'absolute',
          bottom: '10px',
          left: '12px',
          right: '12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pointerEvents: 'none'
        }}>
          <span style={{
            fontSize: '10px',
            color: '#a1a1aa',
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            padding: '3px 8px',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}>
            <Move size={10} /> Rueda del ratón para zoom • Arrastra para explorar
          </span>

          {scale > 1 && (
            <span style={{
              fontSize: '10px',
              color: '#38bdf8',
              background: 'rgba(2,132,199,0.2)',
              border: '1px solid rgba(2,132,199,0.4)',
              padding: '2px 6px',
              borderRadius: '4px',
              fontWeight: 700
            }}>
              Modo Detalle Activo
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export const DualZoomModal: React.FC<DualZoomModalProps> = ({ data, onClose }) => {
  // Listener de tecla ESC para cerrar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const esAlerta = data.estado === 'alerta';
  const esAutorizado = data.estado === 'autorizado';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 9999,
        padding: '24px',
        animation: 'fadeIn 0.2s ease-out'
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '1280px',
          maxHeight: '92vh',
          background: '#121214',
          border: '1px solid #27272a',
          borderRadius: '16px',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.9)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#f4f4f5'
        }}
      >
        {/* Encabezado Principal */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px 24px',
          background: '#0a0a0c',
          borderBottom: '1px solid #27272a',
          flexWrap: 'wrap',
          gap: '12px'
        }}>
          {/* Identificación de Placa y Estado */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{
              background: '#000000',
              border: `2px solid ${esAlerta ? '#ef4444' : esAutorizado ? '#22c55e' : '#38bdf8'}`,
              borderRadius: '8px',
              padding: '4px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
            }}>
              <span style={{
                fontSize: '22px',
                fontWeight: 900,
                color: esAlerta ? '#ef4444' : esAutorizado ? '#22c55e' : '#38bdf8',
                letterSpacing: '2px',
                fontFamily: 'monospace'
              }}>
                {data.placa || 'PLACA NO ASIGNADA'}
              </span>
            </div>

            {/* Badge de Estado */}
            {esAlerta && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: 800,
                color: '#ffffff',
                backgroundColor: '#ef4444',
                padding: '4px 10px',
                borderRadius: '6px'
              }}>
                <ShieldAlert size={14} /> LISTA NEGRA / ALERTA
              </span>
            )}
            {esAutorizado && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: 800,
                color: '#ffffff',
                backgroundColor: '#16a34a',
                padding: '4px 10px',
                borderRadius: '6px'
              }}>
                <ShieldCheck size={14} /> VEHÍCULO AUTORIZADO
              </span>
            )}
            {!esAlerta && !esAutorizado && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                fontWeight: 800,
                color: '#ffffff',
                backgroundColor: '#0284c7',
                padding: '4px 10px',
                borderRadius: '6px'
              }}>
                <HelpCircle size={14} /> REGISTRO DE TRÁNSITO
              </span>
            )}

            {/* Confianza OCR */}
            {data.confianza !== undefined && data.confianza !== null && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                color: '#a1a1aa',
                background: '#1c1c20',
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid #27272a'
              }}>
                <span>Confianza OCR:</span>
                <strong style={{ color: '#38bdf8' }}>{data.confianza}%</strong>
              </div>
            )}
          </div>

          {/* Botón de Cierre */}
          <button
            onClick={onClose}
            style={{
              background: '#27272a',
              border: '1px solid #3f3f46',
              color: '#d4d4d8',
              borderRadius: '8px',
              padding: '6px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              fontWeight: 700,
              transition: 'all 0.15s ease'
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#ef4444';
              e.currentTarget.style.color = '#ffffff';
              e.currentTarget.style.borderColor = '#ef4444';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#27272a';
              e.currentTarget.style.color = '#d4d4d8';
              e.currentTarget.style.borderColor = '#3f3f46';
            }}
          >
            <X size={16} /> Cerrar (ESC)
          </button>
        </div>

        {/* Metadatos Rápidos */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          padding: '8px 24px',
          background: '#141416',
          borderBottom: '1px solid #27272a',
          fontSize: '12px',
          color: '#a1a1aa',
          flexWrap: 'wrap'
        }}>
          {data.fecha && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Calendar size={13} color="#71717a" />
              <span>{data.fecha}</span>
            </div>
          )}
          {data.propietario && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <User size={13} color="#71717a" />
              <span>{data.propietario} {data.tipo_vehiculo ? `(${data.tipo_vehiculo})` : ''}</span>
            </div>
          )}
          {data.camara && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <Camera size={13} color="#71717a" />
              <span>{data.camara}</span>
            </div>
          )}
        </div>

        {/* Cuerpo: Paneles Duales con Zoom Profesional */}
        <div style={{
          padding: '20px 24px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))',
          gap: '20px',
          overflowY: 'auto',
          maxHeight: 'calc(92vh - 150px)'
        }}>
          {/* Panel 1: Foto General del Vehículo */}
          <ImageViewer
            title="Captura General del Vehículo"
            icon={<Camera size={16} />}
            imageUrl={data.vehiculoUrl}
            fallbackUrl={data.placaUrl}
            alt={`Vehículo ${data.placa}`}
            badgeText="Cámara Acceso"
          />

          {/* Panel 2: Recorte Ampliado de la Placa */}
          <ImageViewer
            title="Recorte de Alta Resolución — Placa"
            icon={<Search size={16} />}
            imageUrl={data.placaUrl}
            fallbackUrl={data.vehiculoUrl}
            alt={`Placa ${data.placa}`}
            badgeText="Enfoque OCR"
          />
        </div>
      </div>
    </div>
  );
};

export default DualZoomModal;
