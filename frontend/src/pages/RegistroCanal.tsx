import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import { 
  Video, 
  Plus, 
  Trash2, 
  Edit3, 
  Play, 
  CheckCircle, 
  XCircle, 
  Radio, 
  Search, 
  RefreshCw, 
  Camera, 
  Server, 
  AlertTriangle,
  Wifi,
  Loader2,
  X
} from 'lucide-react';
import api, { API_URL } from '../services/api';

const defaultAnprHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const ANPR_URL = import.meta.env.VITE_ANPR_URL || `http://${defaultAnprHost}:8000`;

interface CameraItem {
  id: number;
  nombre: string;
  ip: string;
  rtsp_url: string;
  ubicacion: string;
  activa: boolean | number;
  estado?: string;
  ultimo_ping?: string;
  tiempo_respuesta_ms?: number | null;
  mensaje_ping?: string | null;
  created_at: string;
}

// Función auxiliar para extraer IP/Host de una URL RTSP
const extractHostFromRtspUrl = (url: string): string => {
  if (!url) return '';
  try {
    const match = url.match(/rtsp:\/\/(?:[^:@]+:[^@]+@)?([a-zA-Z0-9.-]+)(?::\d+)?/i);
    if (match && match[1]) return match[1];
  } catch {}
  return '';
};

const RegistroCanal: React.FC = () => {
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'activa' | 'inactiva'>('all');
  const [pingingId, setPingingId] = useState<number | null>(null);
  const [pingAllLoading, setPingAllLoading] = useState<boolean>(false);
  const [toastNotification, setToastNotification] = useState<{
    tipo: 'success' | 'error' | 'info';
    titulo: string;
    mensaje: string;
    id: number;
  } | null>(null);

  // Modal de Crear / Editar
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCamera, setEditingCamera] = useState<CameraItem | null>(null);
  const [formData, setFormData] = useState({
    nombre: '',
    ip: '',
    rtsp_url: '',
    ubicacion: '',
    activa: true,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Modal de Previsualización en Vivo
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testCamera, setTestCamera] = useState<CameraItem | null>(null);

  // Confirmación de Eliminación
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const fetchCameras = async () => {
    try {
      setLoading(true);
      const res = await api.get('/camaras');
      if (res.data) {
        setCameras(res.data);
      }
    } catch (err: any) {
      console.error('Error al cargar cámaras:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCameras();

    const socketUrl = API_URL.replace(/\/api\/?$/, '');
    const socket = io(socketUrl);

    socket.on('camara_estado_cambiado', (data: any) => {
      setCameras(prev => prev.map(c => c.id === data.id ? { ...c, ...data, activa: data.activa ? 1 : 0 } : c));
    });

    socket.on('notificacion_camara', (notif: any) => {
      setToastNotification({
        tipo: notif.tipo || 'info',
        titulo: notif.titulo || 'Notificación de Canal',
        mensaje: notif.mensaje,
        id: Date.now()
      });
      setTimeout(() => {
        setToastNotification(prev => prev?.id === notif.id ? null : prev);
      }, 7000);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const openCreateModal = () => {
    setEditingCamera(null);
    setFormData({
      nombre: '',
      ip: '192.168.1.100',
      rtsp_url: 'rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101',
      ubicacion: 'Acceso Principal - Garita 1',
      activa: true,
    });
    setFormError(null);
    setFormSuccess(null);
    setModalOpen(true);
  };

  const openEditModal = (cam: CameraItem) => {
    setEditingCamera(cam);
    const initialIp = cam.ip || extractHostFromRtspUrl(cam.rtsp_url) || '';
    setFormData({
      nombre: cam.nombre || '',
      ip: initialIp,
      rtsp_url: cam.rtsp_url || '',
      ubicacion: cam.ubicacion || '',
      activa: Boolean(cam.activa),
    });
    setFormError(null);
    setFormSuccess(null);
    setModalOpen(true);
  };

  // Manejador para cambio de RTSP con auto-extracción de IP
  const handleRtspChange = (newUrl: string) => {
    const extracted = extractHostFromRtspUrl(newUrl);
    setFormData(prev => ({
      ...prev,
      rtsp_url: newUrl,
      ip: (!prev.ip || prev.ip === extractHostFromRtspUrl(prev.rtsp_url)) && extracted ? extracted : prev.ip
    }));
  };

  // Manejador para cambio de IP con sincronización inteligente en RTSP
  const handleIpChange = (newIp: string) => {
    setFormData(prev => {
      let updatedRtsp = prev.rtsp_url;
      const currentHost = extractHostFromRtspUrl(prev.rtsp_url);
      if (currentHost && newIp.trim() && currentHost !== newIp.trim()) {
        updatedRtsp = updatedRtsp.replace(`@${currentHost}:`, `@${newIp.trim()}:`).replace(`@${currentHost}/`, `@${newIp.trim()}/`);
      }
      return {
        ...prev,
        ip: newIp,
        rtsp_url: updatedRtsp
      };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);

    const effectiveIp = formData.ip.trim() || extractHostFromRtspUrl(formData.rtsp_url) || '127.0.0.1';

    if (!formData.nombre.trim() || !formData.rtsp_url.trim()) {
      setFormError('Por favor complete el nombre del canal y la URL RTSP.');
      return;
    }

    const payload = {
      ...formData,
      ip: effectiveIp,
    };

    try {
      setSaving(true);
      if (editingCamera) {
        await api.put(`/camaras/${editingCamera.id}`, payload);
        setFormSuccess('Canal actualizado exitosamente.');
      } else {
        await api.post('/camaras', payload);
        setFormSuccess('Nuevo canal RTSP registrado exitosamente.');
      }

      await fetchCameras();
      setTimeout(() => {
        setModalOpen(false);
      }, 700);
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Error al guardar el canal de video.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: number) => {
    try {
      await api.patch(`/camaras/${id}/toggle`);
      fetchCameras();
    } catch (err) {
      alert('Error al cambiar el estado del canal.');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/camaras/${id}`);
      setDeleteId(null);
      fetchCameras();
    } catch (err) {
      alert('Error al eliminar el canal.');
    }
  };

  const handlePingCamera = async (cam: CameraItem) => {
    try {
      setPingingId(cam.id);
      const res = await api.post(`/camaras/${cam.id}/ping`);
      const { success, estado, timeMs, message, camera } = res.data;

      // Actualización reactiva instantánea
      setCameras(prev => prev.map(c => c.id === cam.id ? { 
        ...c, 
        ...camera, 
        activa: success ? 1 : 0, 
        estado, 
        tiempo_respuesta_ms: timeMs, 
        mensaje_ping: message 
      } : c));

      setToastNotification({
        tipo: success ? 'success' : 'error',
        titulo: `Diagnóstico Ping: ${cam.nombre}`,
        mensaje: success 
          ? `✓ Cámara respondiendo con normalidad (${timeMs}ms). Estado actualizado a ACTIVA en Base de Datos.`
          : `✕ Fallo de conectividad ICMP (${message}). Estado actualizado a INACTIVA en Base de Datos.`,
        id: Date.now()
      });
    } catch (err: any) {
      setToastNotification({
        tipo: 'error',
        titulo: `Error de Ping: ${cam.nombre}`,
        mensaje: err.response?.data?.error || 'No se pudo comunicar con el servidor para realizar el ping.',
        id: Date.now()
      });
    } finally {
      setPingingId(null);
    }
  };

  const handlePingAll = async () => {
    try {
      setPingAllLoading(true);
      const res = await api.post('/camaras/ping-all');
      fetchCameras();
      setToastNotification({
        tipo: 'info',
        titulo: 'Diagnóstico Global Finalizado',
        mensaje: `Resultado: ${res.data.activas} activas, ${res.data.inactivas} inactivas en total.`,
        id: Date.now()
      });
    } catch (err) {
      alert('Error al ejecutar el ping masivo a los canales.');
    } finally {
      setPingAllLoading(false);
    }
  };

  const openTestModal = (cam: CameraItem) => {
    setTestCamera(cam);
    setTestModalOpen(true);
  };

  // Filtrado
  const filteredCameras = cameras.filter(c => {
    const matchesSearch = 
      c.nombre.toLowerCase().includes(search.toLowerCase()) ||
      c.ip.toLowerCase().includes(search.toLowerCase()) ||
      c.ubicacion.toLowerCase().includes(search.toLowerCase()) ||
      c.rtsp_url.toLowerCase().includes(search.toLowerCase());

    const isActiva = Boolean(c.activa);
    const matchesStatus = 
      statusFilter === 'all' || 
      (statusFilter === 'activa' && isActiva) || 
      (statusFilter === 'inactiva' && !isActiva);

    return matchesSearch && matchesStatus;
  });

  const totalCanales = cameras.length;
  const activasCount = cameras.filter(c => Boolean(c.activa)).length;
  const inactivasCount = totalCanales - activasCount;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '24px' }}>
      
      {/* Notificación Realtime de Ping / Estado */}
      {toastNotification && (
        <div
          className="animate-fade-in"
          style={{
            padding: '12px 18px',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            backgroundColor: toastNotification.tipo === 'success' ? 'rgba(22, 163, 74, 0.12)' : toastNotification.tipo === 'error' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(2, 132, 199, 0.12)',
            border: `1px solid ${toastNotification.tipo === 'success' ? '#86efac' : toastNotification.tipo === 'error' ? '#fca5a5' : '#7dd3fc'}`,
            color: toastNotification.tipo === 'success' ? '#15803d' : toastNotification.tipo === 'error' ? '#b91c1c' : '#0369a1',
            boxShadow: '0 4px 14px rgba(0,0,0,0.05)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '6px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backgroundColor: toastNotification.tipo === 'success' ? '#16a34a' : toastNotification.tipo === 'error' ? '#ef4444' : '#0284c7',
              color: '#ffffff', flexShrink: 0
            }}>
              <Wifi size={15} />
            </div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 800 }}>{toastNotification.titulo}</div>
              <div style={{ fontSize: '12px', opacity: 0.9 }}>{toastNotification.mensaje}</div>
            </div>
          </div>
          <button
            onClick={() => setToastNotification(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '4px' }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      
      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 1. Header de Sección & Acciones Principales                         */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ef4444'
              }}
            >
              <Video size={20} />
            </div>
            <div>
              <h1 style={{ fontSize: '20px', fontWeight: 900, color: '#0f172a', letterSpacing: '0.4px' }}>
                Registro de Canales y Cámaras RTSP
              </h1>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Configuración y gestión de flujos de video IP para reconocimiento vehicular en tiempo real.
              </p>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={fetchCameras}
            className="btn glass"
            style={{ color: 'var(--text-secondary)', padding: '9px 14px' }}
            title="Refrescar lista de cámaras"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>

          <button
            onClick={openCreateModal}
            className="btn"
            style={{
              backgroundColor: '#ef4444',
              color: 'white',
              boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)',
              padding: '9px 18px',
              fontWeight: 800
            }}
          >
            <Plus size={16} />
            Registrar Nuevo Canal RTSP
          </button>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 2. Tarjetas de Estadísticas de Canales                              */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        {/* Total Canales */}
        <div
          onClick={() => setStatusFilter('all')}
          className="glass shadow-premium"
          style={{
            padding: '18px',
            borderRadius: '10px',
            cursor: 'pointer',
            borderLeft: '4px solid var(--accent-blue)',
            transition: 'var(--transition-smooth)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Total Canales
            </span>
            <Camera size={18} style={{ color: 'var(--accent-blue)' }} />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 900, color: '#0f172a', marginTop: '8px' }}>
            {totalCanales}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Cámaras configuradas en el sistema
          </div>
        </div>

        {/* Operativas / Activas */}
        <div
          onClick={() => setStatusFilter('activa')}
          className="glass shadow-premium"
          style={{
            padding: '18px',
            borderRadius: '12px',
            cursor: 'pointer',
            borderLeft: '4px solid var(--success)',
            transition: 'var(--transition-smooth)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Canales Operativos
            </span>
            <CheckCircle size={18} style={{ color: 'var(--success)' }} />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 900, color: 'var(--success)', marginTop: '8px' }}>
            {activasCount}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Transmitiendo flujo de video activo
          </div>
        </div>

        {/* Inactivas */}
        <div
          onClick={() => setStatusFilter('inactiva')}
          className="glass shadow-premium"
          style={{
            padding: '18px',
            borderRadius: '12px',
            cursor: 'pointer',
            borderLeft: '4px solid var(--alert-critica)',
            transition: 'var(--transition-smooth)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Canales Inactivos
            </span>
            <XCircle size={18} style={{ color: 'var(--alert-critica)' }} />
          </div>
          <div style={{ fontSize: '28px', fontWeight: 900, color: 'var(--alert-critica)', marginTop: '8px' }}>
            {inactivasCount}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Desconectados o en mantenimiento
          </div>
        </div>

        {/* Protocolo */}
        <div
          className="glass shadow-premium"
          style={{
            padding: '18px',
            borderRadius: '12px',
            borderLeft: '4px solid var(--accent-cyan)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Servidor de Streaming
            </span>
            <Server size={18} style={{ color: 'var(--accent-cyan)' }} />
          </div>
          <div style={{ fontSize: '18px', fontWeight: 900, color: 'white', marginTop: '12px' }}>
            MediaMTX + MJPEG
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Puertos: 8554 (RTSP), 8000 (Stream)
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 3. Filtros y Búsqueda                                              */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div
        className="glass"
        style={{
          padding: '14px 20px',
          borderRadius: '10px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: '1 1 300px' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '380px' }}>
            <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Buscar por nombre, IP, ubicación o RTSP URL..."
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: '34px', width: '100%', fontSize: '13px' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              onClick={() => setStatusFilter('all')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: '1px solid var(--border-color)',
                backgroundColor: statusFilter === 'all' ? 'var(--accent-blue)' : 'transparent',
                color: 'white'
              }}
            >
              Todos ({totalCanales})
            </button>
            <button
              onClick={() => setStatusFilter('activa')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: '1px solid var(--border-color)',
                backgroundColor: statusFilter === 'activa' ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                color: statusFilter === 'activa' ? 'var(--success)' : 'var(--text-secondary)'
              }}
            >
              Activas ({activasCount})
            </button>
            <button
              onClick={() => setStatusFilter('inactiva')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: '1px solid var(--border-color)',
                backgroundColor: statusFilter === 'inactiva' ? 'rgba(239, 68, 68, 0.2)' : 'transparent',
                color: statusFilter === 'inactiva' ? '#f87171' : 'var(--text-secondary)'
              }}
            >
              Inactivas ({inactivasCount})
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={handlePingAll}
            disabled={pingAllLoading}
            style={{
              padding: '6px 13px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: 700,
              cursor: pingAllLoading ? 'wait' : 'pointer',
              border: '1px solid rgba(2, 132, 199, 0.35)',
              backgroundColor: 'rgba(2, 132, 199, 0.10)',
              color: '#0284c7',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.15s ease'
            }}
            title="Ejecutar diagnóstico Ping ICMP a todas las cámaras registradas"
          >
            {pingAllLoading ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
            {pingAllLoading ? 'Diagnosticando...' : 'Diagnóstico Ping Global'}
          </button>

          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Mostrando <strong>{filteredCameras.length}</strong> de {totalCanales} canales
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 4. Tabla de Canales Registrados                                    */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div className="glass shadow-premium" style={{ borderRadius: '10px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
            <thead>
              <tr style={{ backgroundColor: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#475569' }}>
                <th style={{ padding: '12px 18px', fontWeight: 800, width: '60px' }}>ID</th>
                <th style={{ padding: '12px 18px', fontWeight: 800 }}>Nombre del Canal</th>
                <th style={{ padding: '12px 18px', fontWeight: 800 }}>Ubicación</th>
                <th style={{ padding: '12px 18px', fontWeight: 800 }}>Dirección IP</th>
                <th style={{ padding: '12px 18px', fontWeight: 800 }}>URL del Stream RTSP</th>
                <th style={{ padding: '12px 18px', fontWeight: 800, textAlign: 'center' }}>Estado & Ping</th>
                <th style={{ padding: '12px 18px', fontWeight: 800, textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredCameras.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
                    <Video size={36} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                    <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>No se encontraron canales de video registrados.</div>
                    <div style={{ fontSize: '12px', marginTop: '4px' }}>Haz clic en "+ Registrar Nuevo Canal RTSP" para agregar uno.</div>
                  </td>
                </tr>
              ) : (
                filteredCameras.map((cam) => {
                  const isActiva = cam.estado ? (cam.estado === 'ACTIVA') : Boolean(cam.activa);
                  return (
                    <tr
                      key={cam.id}
                      style={{
                        borderBottom: '1px solid #f1f5f9',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <td style={{ padding: '12px 18px', fontWeight: 800, color: '#2563eb' }}>
                        #{cam.id}
                      </td>
                      <td style={{ padding: '12px 18px' }}>
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{cam.nombre}</div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          Registrado: {new Date(cam.created_at || Date.now()).toLocaleDateString('es-EC')}
                        </div>
                      </td>
                      <td style={{ padding: '12px 18px', color: '#475569' }}>
                        {cam.ubicacion || 'Acceso Principal'}
                      </td>
                      <td style={{ padding: '12px 18px' }}>
                        <span style={{ fontFamily: 'monospace', backgroundColor: '#f1f5f9', padding: '3px 8px', borderRadius: '4px', border: '1px solid #cbd5e1', color: '#1e293b', fontSize: '12px' }}>
                          {cam.ip}
                        </span>
                      </td>
                      <td style={{ padding: '12px 18px' }}>
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '11px',
                            color: '#2563eb',
                            maxWidth: '240px',
                            display: 'inline-block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}
                          title={cam.rtsp_url}
                        >
                          {cam.rtsp_url}
                        </span>
                      </td>
                      <td style={{ padding: '12px 18px', textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                          <button
                            onClick={() => handleToggle(cam.id)}
                            style={{
                              border: '1px solid',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              padding: '4px 10px',
                              borderRadius: '12px',
                              fontSize: '11px',
                              fontWeight: 800,
                              backgroundColor: isActiva ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                              color: isActiva ? '#059669' : '#dc2626',
                              borderColor: isActiva ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
                              transition: 'all 0.15s ease'
                            }}
                            title="Clic para conmutar estado manualmente"
                          >
                            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: isActiva ? '#10b981' : '#ef4444' }} />
                            <span>{isActiva ? 'ACTIVA' : 'INACTIVA'}</span>
                            {cam.tiempo_respuesta_ms != null && isActiva && (
                              <span style={{ fontSize: '10px', opacity: 0.85, marginLeft: '2px', fontWeight: 600 }}>
                                {cam.tiempo_respuesta_ms}ms
                              </span>
                            )}
                          </button>

                          {/* Botón WiFi para comprobar Ping ICMP y actualizar estado automáticamente */}
                          <button
                            onClick={() => handlePingCamera(cam)}
                            disabled={pingingId === cam.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '30px',
                              height: '30px',
                              borderRadius: '8px',
                              border: `1px solid ${isActiva ? '#bae6fd' : '#e2e8f0'}`,
                              backgroundColor: pingingId === cam.id ? '#f1f5f9' : (isActiva ? '#f0f9ff' : '#ffffff'),
                              color: isActiva ? '#0284c7' : '#64748b',
                              cursor: pingingId === cam.id ? 'not-allowed' : 'pointer',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                              transition: 'all 0.2s ease'
                            }}
                            title={`Probar Ping WiFi (${cam.ip || 'Host'}) - Actualizar estado a ACTIVA/INACTIVA`}
                          >
                            {pingingId === cam.id ? (
                              <Loader2 size={15} className="animate-spin text-blue-600" />
                            ) : (
                              <Wifi size={15} />
                            )}
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
                          <button
                            onClick={() => openTestModal(cam)}
                            style={{
                              padding: '6px 10px',
                              backgroundColor: 'rgba(58, 134, 200, 0.15)',
                              border: '1px solid rgba(58, 134, 200, 0.3)',
                              borderRadius: '6px',
                              color: 'var(--accent-cyan)',
                              fontSize: '11px',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px'
                            }}
                            title="Previsualizar Stream en vivo"
                          >
                            <Play size={12} />
                            Probar
                          </button>

                          <button
                            onClick={() => openEditModal(cam)}
                            style={{
                              padding: '6px 8px',
                              backgroundColor: 'rgba(255, 255, 255, 0.06)',
                              border: '1px solid var(--border-color)',
                              borderRadius: '6px',
                              color: 'var(--text-secondary)',
                              cursor: 'pointer',
                            }}
                            title="Editar configuración del canal"
                          >
                            <Edit3 size={13} />
                          </button>

                          <button
                            onClick={() => setDeleteId(cam.id)}
                            style={{
                              padding: '6px 8px',
                              backgroundColor: 'rgba(239, 68, 68, 0.1)',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              borderRadius: '6px',
                              color: '#f87171',
                              cursor: 'pointer',
                            }}
                            title="Eliminar canal"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
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
      {/* 5. Modal: Registrar / Editar Canal RTSP                             */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {modalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            padding: '20px'
          }}
        >
          <div
            className="glass shadow-premium animate-fade-in"
            style={{
              width: '100%',
              maxWidth: '580px',
              borderRadius: '14px',
              padding: '28px',
              border: '1px solid #334155',
              backgroundColor: '#0f172a',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ef4444'
                  }}
                >
                  <Video size={20} />
                </div>
                <div>
                  <h3 style={{ fontSize: '18px', fontWeight: 900, color: '#f8fafc', margin: 0 }}>
                    {editingCamera ? 'Editar Configuración de Canal RTSP' : 'Registrar Nuevo Canal de Video'}
                  </h3>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    {editingCamera ? `ID #${editingCamera.id} - ${editingCamera.nombre}` : 'Integración de flujo IP de ultra-baja latencia'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '20px', padding: '4px' }}
                title="Cerrar ventana"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div style={{ padding: '10px 14px', borderRadius: '6px', backgroundColor: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: '12px', marginBottom: '16px' }}>
                ⚠️ {formError}
              </div>
            )}

            {formSuccess && (
              <div style={{ padding: '10px 14px', borderRadius: '6px', backgroundColor: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#86efac', fontSize: '12px', marginBottom: '16px' }}>
                ✓ {formSuccess}
              </div>
            )}

            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
                  Nombre Descriptivo del Canal *
                </label>
                <input
                  type="text"
                  placeholder="Ej: Cámara Garita Norte - Acceso Vehicular"
                  className="input"
                  value={formData.nombre}
                  onChange={e => setFormData({ ...formData, nombre: e.target.value })}
                  style={{ width: '100%', backgroundColor: '#1e293b', borderColor: '#475569', color: '#ffffff' }}
                  required
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 700, color: '#e2e8f0' }}>
                      Dirección IP / Host *
                    </label>
                    {extractHostFromRtspUrl(formData.rtsp_url) && (
                      <button
                        type="button"
                        onClick={() => {
                          const host = extractHostFromRtspUrl(formData.rtsp_url);
                          if (host) setFormData(prev => ({ ...prev, ip: host }));
                        }}
                        style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: '10px', cursor: 'pointer', fontWeight: 700, padding: 0 }}
                        title="Extraer IP de la URL RTSP"
                      >
                        Auto-detectar
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    placeholder="Ej: 10.126.9.104 o 192.168.1.100"
                    className="input"
                    value={formData.ip}
                    onChange={e => handleIpChange(e.target.value)}
                    style={{ width: '100%', backgroundColor: '#1e293b', borderColor: '#475569', color: '#ffffff', fontFamily: 'monospace' }}
                    required
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
                    Ubicación / Sector
                  </label>
                  <input
                    type="text"
                    placeholder="Ej: Acceso Principal"
                    className="input"
                    value={formData.ubicacion}
                    onChange={e => setFormData({ ...formData, ubicacion: e.target.value })}
                    style={{ width: '100%', backgroundColor: '#1e293b', borderColor: '#475569', color: '#ffffff' }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
                  URL RTSP o Stream de Video *
                </label>
                <input
                  type="text"
                  placeholder="rtsp://admin:password@10.126.9.104:554/Streaming/Channels/101"
                  className="input"
                  value={formData.rtsp_url}
                  onChange={e => handleRtspChange(e.target.value)}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px', backgroundColor: '#1e293b', borderColor: '#475569', color: '#38bdf8' }}
                  required
                />
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                  Soporta RTSP (puerto 554/8554 Hikvision/Dahua/Celular), HLS (.m3u8), MJPEG HTTP stream.
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px', backgroundColor: '#1e293b', padding: '10px 14px', borderRadius: '8px', border: '1px solid #334155' }}>
                <input
                  type="checkbox"
                  id="canal-activa"
                  checked={formData.activa}
                  onChange={e => setFormData({ ...formData, activa: e.target.checked })}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#ef4444' }}
                />
                <label htmlFor="canal-activa" style={{ fontSize: '12px', fontWeight: 700, color: '#f8fafc', cursor: 'pointer' }}>
                  Habilitar transmisión y análisis ANPR continuo en este canal
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="btn glass"
                  style={{ color: '#cbd5e1', border: '1px solid #475569' }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="btn"
                  style={{
                    backgroundColor: '#ef4444',
                    color: 'white',
                    fontWeight: 800,
                    minWidth: '140px',
                    boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)'
                  }}
                >
                  {saving ? 'Guardando...' : (editingCamera ? 'Guardar Cambios' : 'Registrar Canal')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 6. Modal: Previsualización de Stream en Vivo                        */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {testModalOpen && testCamera && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            padding: '20px'
          }}
        >
          <div
            className="glass shadow-premium animate-fade-in"
            style={{
              width: '100%',
              maxWidth: '800px',
              borderRadius: '14px',
              padding: '24px',
              border: '1px solid var(--border-color)',
              backgroundColor: '#0b1329'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--success)' }} />
                  <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'white' }}>
                    Stream en Vivo: {testCamera.nombre}
                  </h3>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {testCamera.ubicacion} | IP: {testCamera.ip} | RTSP: {testCamera.rtsp_url}
                </div>
              </div>
              <button
                onClick={() => setTestModalOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '18px' }}
              >
                ✕
              </button>
            </div>

            {/* Video Player */}
            <div
              style={{
                width: '100%',
                height: '420px',
                backgroundColor: '#000',
                borderRadius: '10px',
                overflow: 'hidden',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
            >
              <img
                key={testCamera.rtsp_url}
                src={`${ANPR_URL}/stream/preview?url=${encodeURIComponent(testCamera.rtsp_url)}`}
                alt={`Stream RTSP en Vivo - ${testCamera.nombre}`}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '12px',
                  left: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(0, 0, 0, 0.75)',
                  color: '#38bdf8',
                  fontSize: '11px',
                  fontWeight: 800,
                  backdropFilter: 'blur(4px)',
                  border: '1px solid rgba(56, 189, 248, 0.3)'
                }}
              >
                <Radio size={12} className="animate-pulse" />
                CANAL RTSP: {testCamera.nombre}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
              <a
                href={`/?canal=${testCamera.id}`}
                className="btn"
                style={{
                  backgroundColor: '#ef4444',
                  color: 'white',
                  fontWeight: 800,
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  textDecoration: 'none',
                  padding: '8px 14px',
                  borderRadius: '6px'
                }}
              >
                <Play size={14} /> Abrir en Monitoreo ANPR en Vivo
              </a>
              <button
                onClick={() => setTestModalOpen(false)}
                className="btn glass"
                style={{ color: 'white' }}
              >
                Cerrar Visor
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 7. Modal de Confirmación de Eliminación                             */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {deleteId !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            padding: '20px'
          }}
        >
          <div
            className="glass shadow-premium animate-fade-in"
            style={{
              width: '100%',
              maxWidth: '420px',
              borderRadius: '12px',
              padding: '24px',
              border: '1px solid var(--alert-critica)',
              backgroundColor: '#111c38'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#f87171', marginBottom: '12px' }}>
              <AlertTriangle size={24} />
              <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'white' }}>
                ¿Eliminar Canal de Video?
              </h3>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
              Esta acción desvinculará la cámara del sistema ANPR. Los registros históricos de ingresos no se borrarán.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setDeleteId(null)}
                className="btn glass"
                style={{ color: 'var(--text-secondary)' }}
              >
                Cancelar
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="btn"
                style={{ backgroundColor: '#ef4444', color: 'white', fontWeight: 800 }}
              >
                Sí, Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default RegistroCanal;
