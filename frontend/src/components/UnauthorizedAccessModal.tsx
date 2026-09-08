import React, { useState } from 'react';
import {
  ShieldAlert,
  AlertOctagon,
  X,
  Volume2,
  VolumeX,
  PhoneCall,
  CheckCircle2,
  Eye,
  Camera
} from 'lucide-react';

export interface UnauthorizedDetectionData {
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
  fecha_hora?: string;
  camara_nombre?: string;
  camara_ubicacion?: string;
  alerta_motivo?: string;
  nivel_alerta?: string;
  tipo_vehiculo?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  data: UnauthorizedDetectionData | null;
  onSilenceAudio?: () => void;
  isAudioMuted?: boolean;
}

export const UnauthorizedAccessModal: React.FC<Props> = ({
  isOpen,
  onClose,
  data,
  onSilenceAudio,
  isAudioMuted = false,
}) => {
  const [reportadoCentral, setReportadoCentral] = useState(false);

  if (!isOpen || !data) return null;

  const displayPlate = (data.placa_reconocida || data.placa || 'SIN PLACA').toUpperCase();
  const plateImgSrc = data.ruta_imagen_placa || data.imagen_placa_path || data.ruta_imagen_ingreso || data.imagen_vehiculo_path;
  const carImgSrc = data.ruta_imagen_ingreso || data.imagen_vehiculo_path;
  const horaStr = new Date(data.fecha_hora_ingreso || data.fecha_hora || Date.now()).toLocaleTimeString();
  const fechaStr = new Date(data.fecha_hora_ingreso || data.fecha_hora || Date.now()).toLocaleDateString();
  const motivo = data.alerta_motivo || 'Vehículo no registrado en la base de datos de accesos permitidos';
  const nivel = data.nivel_alerta || 'CRITICA';

  const handleReportarCentral = () => {
    setReportadoCentral(true);
    setTimeout(() => setReportadoCentral(false), 4000);
  };

  return (
    <div
      className="unauthorized-modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '920px',
          background: '#0b1329',
          borderRadius: '16px',
          border: '2px solid #ef4444',
          boxShadow: '0 25px 60px -15px rgba(239, 68, 68, 0.65), 0 0 40px rgba(239, 68, 68, 0.40)',
          color: '#ffffff',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'fadeIn 0.25s ease-out',
        }}
      >
        {/* Cabecera de Alerta Roja */}
        <div
          style={{
            background: 'linear-gradient(90deg, #991b1b 0%, #dc2626 50%, #991b1b 100%)',
            padding: '16px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '2px solid #ef4444',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '50%',
                background: '#ffffff',
                color: '#dc2626',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 15px rgba(255, 255, 255, 0.6)',
              }}
            >
              <AlertOctagon size={26} strokeWidth={2.5} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h1 style={{ fontSize: '18px', fontWeight: 900, letterSpacing: '0.5px', margin: 0, color: '#ffffff' }}>
                  ALERTA DE SEGURIDAD: ACCESO NO AUTORIZADO
                </h1>
                <span
                  style={{
                    background: '#000000',
                    color: '#f87171',
                    fontSize: '11px',
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    border: '1px solid #ef4444',
                  }}
                >
                  NIVEL {nivel}
                </span>
              </div>
              <p style={{ fontSize: '12px', opacity: 0.9, margin: '2px 0 0 0', color: '#fee2e2' }}>
                SISTEMA INTEGRADO ANPR ECU 911 | PROTOCOLO DE INTERVENCIÓN INMEDIATA EN GARITA
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'rgba(0, 0, 0, 0.4)',
              border: '1px solid rgba(255, 255, 255, 0.3)',
              color: '#ffffff',
              borderRadius: '8px',
              padding: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.2s',
            }}
            title="Cerrar modal"
          >
            <X size={20} />
          </button>
        </div>

        {/* Cuerpo del Modal: 2 Columnas */}
        <div style={{ padding: '24px', display: 'grid', gridTemplateColumns: '1fr 1.15fr', gap: '24px' }}>
          
          {/* Columna Izquierda: Información del Vehículo y Evidencia Fotográfica */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            
            {/* Placa Emblema Ecuatoriana */}
            <div
              style={{
                background: '#ffffff',
                color: '#0f172a',
                borderRadius: '8px',
                padding: '12px 18px',
                border: '3px solid #1e293b',
                boxShadow: '0 6px 16px rgba(0, 0, 0, 0.4)',
                textAlign: 'center',
                position: 'relative',
              }}
            >
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 800,
                  letterSpacing: '3px',
                  color: '#64748b',
                  marginBottom: '2px',
                }}
              >
                REPÚBLICA DEL ECUADOR
              </div>
              <div
                style={{
                  fontSize: '34px',
                  fontWeight: 900,
                  letterSpacing: '2px',
                  fontFamily: 'monospace',
                  color: '#000000',
                  lineHeight: '1.1',
                }}
              >
                {displayPlate}
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: '4px',
                  fontSize: '11px',
                  color: '#dc2626',
                  fontWeight: 800,
                }}
              >
                <span>ANT / ZONA 3</span>
                <span>ESTADO: NO AUTORIZADO</span>
              </div>
            </div>

            {/* Ficha Rápida de Datos */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px',
                padding: '14px',
                fontSize: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>Motivo de Alerta:</span>
                <span style={{ fontWeight: 700, color: '#fca5a5' }}>{motivo}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>Ubicación:</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{data.camara_nombre || 'Garita Principal'} ({data.camara_ubicacion || 'Acceso 1'})</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>Fecha y Hora:</span>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{fechaStr} • {horaStr}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#94a3b8' }}>ID Registro:</span>
                <span style={{ fontWeight: 600, color: '#38bdf8' }}>#{data.id}</span>
              </div>
            </div>

            {/* Recortes de Evidencia Visual */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Eye size={13} /> Recorte de Placa:
                </div>
                <div style={{ height: '85px', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(239, 68, 68, 0.4)', background: '#000000' }}>
                  {plateImgSrc ? (
                    <img
                      src={`http://localhost:5000/media/${plateImgSrc.split('/').pop()}`}
                      alt="Recorte Placa"
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '11px' }}>Sin recorte</div>
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Camera size={13} /> Foto Panorámica:
                </div>
                <div style={{ height: '85px', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(255, 255, 255, 0.1)', background: '#000000' }}>
                  {carImgSrc ? (
                    <img
                      src={`http://localhost:5000/media/${carImgSrc.split('/').pop()}`}
                      alt="Vehículo"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '11px' }}>Sin captura</div>
                  )}
                </div>
              </div>
            </div>

          </div>

          {/* Columna Derecha: Indicaciones Profesionales para el Guardia (SOP) */}
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '12px',
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#fca5a5', borderBottom: '1px solid rgba(239,68,68,0.25)', paddingBottom: '8px' }}>
              <ShieldAlert size={20} />
              <h3 style={{ fontSize: '14px', fontWeight: 800, margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Protocolo Obligatorio para el Personal de Seguridad
              </h3>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '11px', fontSize: '12px', lineHeight: '1.45' }}>
              
              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <div style={{ background: '#dc2626', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0, fontSize: '11px' }}>
                  1
                </div>
                <div>
                  <strong style={{ color: '#ffffff' }}>MANTENER LA BARRERA ABAJO:</strong>
                  <div style={{ color: '#fecaca' }}>
                    Bajo ninguna circunstancia accione la pluma electromecánica ni permita el ingreso del vehículo.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <div style={{ background: '#dc2626', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0, fontSize: '11px' }}>
                  2
                </div>
                <div>
                  <strong style={{ color: '#ffffff' }}>INSPECCIÓN VISUAL PREVENTIVA:</strong>
                  <div style={{ color: '#cbd5e1' }}>
                    Desde el punto seguro de la garita, confirme que la placa física coincida con <strong>{displayPlate}</strong> e identifique cantidad de ocupantes.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <div style={{ background: '#dc2626', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0, fontSize: '11px' }}>
                  3
                </div>
                <div>
                  <strong style={{ color: '#ffffff' }}>SOLICITUD DE CREDENCIALES:</strong>
                  <div style={{ color: '#cbd5e1' }}>
                    Solicite al conductor su <strong>Cédula de Identidad</strong>, <strong>Matrícula vehicular</strong> y justificación formal del motivo de ingreso.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <div style={{ background: '#dc2626', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0, fontSize: '11px' }}>
                  4
                </div>
                <div>
                  <strong style={{ color: '#ffffff' }}>COMUNICACIÓN INMEDIATA POR RADIO:</strong>
                  <div style={{ color: '#cbd5e1' }}>
                    Reporte la placa <strong>{displayPlate}</strong> al Supervisor de Turno (Canal 1) o notifique a la Central ECU 911 si el automotor persiste o actúa con sospecha.
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <div style={{ background: '#dc2626', color: '#ffffff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0, fontSize: '11px' }}>
                  5
                </div>
                <div>
                  <strong style={{ color: '#ffffff' }}>DESVÍO A BAHÍA DE ESPERA:</strong>
                  <div style={{ color: '#cbd5e1' }}>
                    Indique al conductor estacionar en la zona lateral de retorno para no obstruir el carril de acceso.
                  </div>
                </div>
              </div>

            </div>

            {/* Aviso de confirmación de despacho */}
            {reportadoCentral && (
              <div
                style={{
                  background: 'rgba(22, 163, 74, 0.2)',
                  border: '1px solid #16a34a',
                  color: '#86efac',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  animation: 'fadeIn 0.2s',
                }}
              >
                <CheckCircle2 size={16} />
                <span>Novedad reportada exitosamente a la Central de Monitoreo ECU 911.</span>
              </div>
            )}

          </div>

        </div>

        {/* Barra Inferior de Acciones */}
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.95)',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '14px 24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', gap: '10px' }}>
            {onSilenceAudio && (
              <button
                onClick={onSilenceAudio}
                style={{
                  background: isAudioMuted ? 'rgba(255, 255, 255, 0.1)' : '#dc2626',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  color: '#ffffff',
                  padding: '9px 15px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                {isAudioMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                {isAudioMuted ? 'Alarma Silenciada' : 'Silenciar Alarma'}
              </button>
            )}

            <button
              onClick={handleReportarCentral}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: '#f8fafc',
                padding: '9px 15px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <PhoneCall size={14} color="#f87171" />
              Notificar Central ECU 911
            </button>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
              border: 'none',
              color: '#ffffff',
              padding: '10px 22px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 800,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: '0 4px 12px rgba(22, 163, 74, 0.4)',
            }}
          >
            <CheckCircle2 size={16} />
            Entendido / Iniciar Protocolo de Seguridad
          </button>
        </div>

      </div>
    </div>
  );
};

export default UnauthorizedAccessModal;
