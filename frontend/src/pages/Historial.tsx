import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { 
  Search, 
  ShieldAlert, 
  ShieldCheck,
  Eye, 
  FileSpreadsheet, 
  Trash2, 
  MapPin, 
  RefreshCw,
  Car,
  Edit,
  X
} from 'lucide-react';

interface DeteccionEvento {
  id: number;
  placa: string;
  placa_reconocida?: string;
  placa_validada?: string;
  validado_manualmente: boolean;
  confianza_deteccion: number;
  confianza_ocr?: number;
  imagen_vehiculo_path?: string;
  imagen_placa_path?: string;
  ruta_imagen_ingreso?: string;
  ruta_imagen_placa?: string;
  fecha_hora?: string;
  fecha_hora_ingreso?: string;
  estado_validacion: 'autorizado' | 'alerta' | 'no_reconocido' | 'pendiente_revision';
  estado_procesamiento?: string;
  tracking_id?: number;
  camara_id?: number;
  camara_nombre?: string;
  camara_ubicacion?: string;
  alerta_id?: number;
  alerta_motivo?: string;
  nivel_alerta?: string;
  propietario?: string;
  departamento?: string;
  tipo_vehiculo?: string;
}

const Historial: React.FC = () => {
  const [eventos, setEventos] = useState<DeteccionEvento[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Filtros
  const [placa, setPlaca] = useState('');
  const [estado, setEstado] = useState('todos');
  const [fechaInicio, setFechaInicio] = useState('');
  const [fechaFin, setFechaFin] = useState('');
  const [camaras, setCamaras] = useState<any[]>([]);
  const [camaraId, setCamaraId] = useState('');

  // Modal Detalle
  const [selectedEvento, setSelectedEvento] = useState<DeteccionEvento | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Modal Corrección / Validación Manual
  const [showValidador, setShowValidador] = useState(false);
  const [placaManual, setPlacaManual] = useState('');

  // Resumen de Métricas
  const totalEventos = eventos.length;
  const totalAutorizados = eventos.filter(e => e.estado_validacion === 'autorizado').length;
  const totalAlertas = eventos.filter(e => e.estado_validacion === 'alerta' || e.alerta_id).length;
  const totalNoReconocidos = eventos.filter(e => e.estado_validacion === 'no_reconocido').length;

  const getMediaUrl = (imgPath?: string) => {
    if (!imgPath) return '';
    const filename = imgPath.split('/').pop()?.split('\\').pop();
    return `http://localhost:5000/media/${filename}`;
  };

  useEffect(() => {
    loadCamaras();
    buscarEventos();
  }, []);

  const loadCamaras = async () => {
    try {
      const res = await api.get('/camaras');
      setCamaras(res.data);
    } catch {
      setCamaras([{ id: 1, nombre: 'Acceso Principal (Zonal 3)' }]);
    }
  };

  const buscarEventos = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (placa.trim()) params.placa = placa.toUpperCase().trim();
      if (estado !== 'todos') params.estado = estado;
      if (fechaInicio) params.fechaInicio = new Date(fechaInicio).toISOString();
      if (fechaFin) params.fechaFin = new Date(fechaFin).toISOString();
      if (camaraId) params.camaraId = camaraId;

      const res = await api.get('/detecciones', { params });
      setEventos(res.data);
    } catch (error) {
      console.error('Error al buscar eventos en historial:', error);
    } finally {
      setLoading(false);
    }
  };

  const limpiarFiltros = () => {
    setPlaca('');
    setEstado('todos');
    setFechaInicio('');
    setFechaFin('');
    setCamaraId('');
    setTimeout(() => {
      buscarEventos();
    }, 50);
  };

  const exportarCSV = async () => {
    try {
      const params: any = {};
      if (placa.trim()) params.placa = placa.toUpperCase().trim();
      if (estado !== 'todos') params.estado = estado;
      if (fechaInicio) params.fechaInicio = new Date(fechaInicio).toISOString();
      if (fechaFin) params.fechaFin = new Date(fechaFin).toISOString();
      if (camaraId) params.camaraId = camaraId;

      const res = await api.get('/detecciones/exportar', {
        params,
        responseType: 'blob'
      });

      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reporte_ingresos_anpr_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert('Error al exportar reporte en CSV.');
    }
  };

  const handleDeleteIndividual = async (id: number) => {
    if (!window.confirm(`¿Está seguro de eliminar el registro #${id} del historial?`)) return;
    try {
      await api.delete(`/detecciones/${id}`);
      setEventos(prev => prev.filter(e => e.id !== id));
      if (selectedEvento?.id === id) setShowModal(false);
    } catch {
      alert('Error al eliminar registro.');
    }
  };

  const abrirValidador = (evento: DeteccionEvento) => {
    setSelectedEvento(evento);
    setPlacaManual(evento.validado_manualmente ? (evento.placa_validada || '') : (evento.placa_reconocida || evento.placa || ''));
    setShowValidador(true);
  };

  const guardarValidacion = async () => {
    if (!selectedEvento || !placaManual.trim()) return;

    try {
      const res = await api.post(`/detecciones/validar/${selectedEvento.id}`, {
        placa_validada: placaManual.toUpperCase().trim()
      });

      if (res.data && res.data.deteccion) {
        setEventos(prev => prev.map(e => e.id === selectedEvento.id ? res.data.deteccion : e));
        setSelectedEvento(res.data.deteccion);
      }

      setShowValidador(false);
    } catch {
      alert('Error al guardar la validación manual.');
    }
  };

  const renderBadge = (evento: DeteccionEvento) => {
    const esAlerta = evento.estado_validacion === 'alerta' || evento.alerta_id;
    const esAutorizado = evento.estado_validacion === 'autorizado';

    if (esAlerta) {
      return (
        <span style={{ 
          fontSize: '10px', 
          fontWeight: 800, 
          color: '#ef4444', 
          backgroundColor: '#fef2f2', 
          border: '1px solid #fecaca', 
          padding: '2px 7px', 
          borderRadius: '4px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px'
        }}>
          <ShieldAlert size={12} />
          LISTA NEGRA
        </span>
      );
    }

    if (esAutorizado) {
      return (
        <span style={{ 
          fontSize: '10px', 
          fontWeight: 800, 
          color: '#16a34a', 
          backgroundColor: '#f0fdf4', 
          border: '1px solid #bbf7d0', 
          padding: '2px 7px', 
          borderRadius: '4px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px'
        }}>
          <ShieldCheck size={12} />
          AUTORIZADO
        </span>
      );
    }

    return (
      <span style={{ 
        fontSize: '10px', 
        fontWeight: 700, 
        color: '#64748b', 
        backgroundColor: '#f1f5f9', 
        border: '1px solid #e2e8f0', 
        padding: '2px 7px', 
        borderRadius: '4px' 
      }}>
        NO RECONOCIDO
      </span>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '24px' }}>
      
      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 1. Header & Botón Exportar                                         */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 900, color: '#0f172a', letterSpacing: '-0.3px' }}>
            Historial de Ingresos Vehiculares (LPR / ANPR)
          </h2>
          <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
            Auditoría integral de accesos, validación de placas y reportes del ECU 911 Zona 3.
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            onClick={buscarEventos} 
            className="btn btn-secondary"
            style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 700, gap: '6px' }}
            title="Recargar datos"
          >
            <RefreshCw size={14} />
            Actualizar
          </button>
          <button 
            onClick={exportarCSV} 
            className="btn btn-primary"
            style={{ background: '#16a34a', borderColor: '#16a34a', color: 'white', fontWeight: 800, padding: '8px 16px', fontSize: '12px', gap: '6px' }}
          >
            <FileSpreadsheet size={16} />
            Exportar CSV
          </button>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 2. Tarjetas de Resumen KPI                                         */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        
        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '10px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Total Registros
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#0f172a', marginTop: '4px' }}>
            {totalEventos}
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
            Capturas registradas
          </div>
        </div>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '10px', background: '#ffffff', border: '1px solid #bbf7d0' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Lista Blanca (Autorizados)
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#16a34a', marginTop: '4px' }}>
            {totalAutorizados}
          </div>
          <div style={{ fontSize: '11px', color: '#86efac', marginTop: '2px' }}>
            Acceso permitido
          </div>
        </div>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '10px', background: '#ffffff', border: '1px solid #fecaca' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Lista Negra (Alertas)
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#ef4444', marginTop: '4px' }}>
            {totalAlertas}
          </div>
          <div style={{ fontSize: '11px', color: '#fca5a5', marginTop: '2px' }}>
            Vehículos sospechosos
          </div>
        </div>

        <div className="glass shadow-premium" style={{ padding: '16px 20px', borderRadius: '10px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            No Reconocidos
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#475569', marginTop: '4px' }}>
            {totalNoReconocidos}
          </div>
          <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
            Sin registro previo
          </div>
        </div>

      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 3. Panel de Filtros Avanzados                                      */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div className="glass shadow-premium" style={{ padding: '20px', borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', alignItems: 'end' }}>
          
          {/* Búsqueda por Placa */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
              Placa del Vehículo
            </label>
            <input 
              type="text" 
              className="input" 
              placeholder="Ej. PBA-5678 o TCA"
              value={placa}
              onChange={(e) => setPlaca(e.target.value)}
              style={{ textTransform: 'uppercase', fontWeight: 700 }}
            />
          </div>

          {/* Selector de Estado */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
              Estado / Lista
            </label>
            <select 
              className="input"
              value={estado}
              onChange={(e) => setEstado(e.target.value)}
              style={{ height: '42px', fontWeight: 600 }}
            >
              <option value="todos">Todos los Estados</option>
              <option value="autorizado">🟢 Autorizados (Lista Blanca)</option>
              <option value="alerta">🔴 Alertas (Lista Negra)</option>
              <option value="no_reconocido">⚪ No Reconocidos</option>
            </select>
          </div>

          {/* Selector de Cámara */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
              Cámara / Canal RTSP
            </label>
            <select 
              className="input"
              value={camaraId}
              onChange={(e) => setCamaraId(e.target.value)}
              style={{ height: '42px' }}
            >
              <option value="">Todas las cámaras</option>
              {camaras.map(c => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </select>
          </div>

          {/* Fecha Inicio */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
              Desde
            </label>
            <input 
              type="datetime-local" 
              className="input" 
              value={fechaInicio}
              onChange={(e) => setFechaInicio(e.target.value)}
              style={{ height: '42px', fontSize: '12px' }}
            />
          </div>

          {/* Fecha Fin */}
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
              Hasta
            </label>
            <input 
              type="datetime-local" 
              className="input" 
              value={fechaFin}
              onChange={(e) => setFechaFin(e.target.value)}
              style={{ height: '42px', fontSize: '12px' }}
            />
          </div>

          {/* Botones de acción */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              onClick={limpiarFiltros} 
              className="btn btn-secondary"
              style={{ flex: 1, height: '42px', fontSize: '12px', fontWeight: 700 }}
            >
              Limpiar
            </button>
            <button 
              onClick={buscarEventos} 
              className="btn btn-primary"
              style={{ flex: 1, height: '42px', fontSize: '12px', fontWeight: 800, gap: '4px' }}
            >
              <Search size={15} />
              Filtrar
            </button>
          </div>

        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 4. Tabla de Registros                                              */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div className="glass shadow-premium" style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid #e2e8f0', background: '#ffffff' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>
            Consultando registros en base de datos...
          </div>
        ) : eventos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#64748b' }}>
            No se encontraron registros con los filtros seleccionados.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 800 }}>
                  <th style={{ padding: '12px 16px' }}>Evidencia</th>
                  <th style={{ padding: '12px 16px' }}>Placa</th>
                  <th style={{ padding: '12px 16px' }}>Estado</th>
                  <th style={{ padding: '12px 16px' }}>Detalles / Propietario</th>
                  <th style={{ padding: '12px 16px' }}>Cámara</th>
                  <th style={{ padding: '12px 16px' }}>Fecha y Hora</th>
                  <th style={{ padding: '12px 16px' }}>Confianza</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {eventos.map((e) => {
                  const fotoVehiculo = e.ruta_imagen_ingreso || e.imagen_vehiculo_path;
                  const fotoPlaca = e.ruta_imagen_placa || e.imagen_placa_path || fotoVehiculo;
                  const placaDisplay = e.validado_manualmente ? (e.placa_validada || e.placa) : (e.placa_reconocida || e.placa);

                  return (
                    <tr 
                      key={e.id} 
                      style={{ 
                        borderBottom: '1px solid #f1f5f9', 
                        transition: 'background 0.15s',
                        backgroundColor: e.estado_validacion === 'alerta' ? '#fff1f2' : 'transparent' 
                      }}
                    >
                      {/* Miniatura Evidencia */}
                      <td style={{ padding: '10px 16px' }}>
                        <div 
                          onClick={() => { setSelectedEvento(e); setShowModal(true); }}
                          style={{ width: '75px', height: '45px', borderRadius: '4px', overflow: 'hidden', border: '1px solid #cbd5e1', background: '#0f172a', cursor: 'pointer' }}
                          title="Clic para ver fotografía ampliada"
                        >
                          <img 
                            src={getMediaUrl(fotoPlaca)} 
                            alt="Placa" 
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                          />
                        </div>
                      </td>

                      {/* Placa */}
                      <td style={{ padding: '10px 16px' }}>
                        <div style={{ fontSize: '15px', fontWeight: 900, color: '#0f172a', letterSpacing: '0.5px' }}>
                          {placaDisplay}
                        </div>
                        {e.validado_manualmente && (
                          <span style={{ fontSize: '9px', color: '#16a34a', fontWeight: 800 }}>
                            ✓ Validado manual
                          </span>
                        )}
                      </td>

                      {/* Estado Badge */}
                      <td style={{ padding: '10px 16px' }}>
                        {renderBadge(e)}
                      </td>

                      {/* Información Adicional */}
                      <td style={{ padding: '10px 16px' }}>
                        {e.estado_validacion === 'autorizado' && (
                          <div>
                            <div style={{ fontWeight: 700, color: '#16a34a' }}>{e.propietario || 'Autorizado'}</div>
                            <div style={{ fontSize: '11px', color: '#64748b' }}>{e.departamento} {e.tipo_vehiculo ? `• ${e.tipo_vehiculo}` : ''}</div>
                          </div>
                        )}
                        {e.estado_validacion === 'alerta' && (
                          <div>
                            <div style={{ fontWeight: 700, color: '#dc2626' }}>{e.alerta_motivo || 'Vehículo en Lista Negra'}</div>
                            <div style={{ fontSize: '10px', color: '#f87171' }}>Nivel: {e.nivel_alerta || 'ALTA'}</div>
                          </div>
                        )}
                        {e.estado_validacion === 'no_reconocido' && (
                          <span style={{ color: '#94a3b8' }}>Ingreso estándar</span>
                        )}
                      </td>

                      {/* Cámara */}
                      <td style={{ padding: '10px 16px', color: '#475569', fontWeight: 600 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <MapPin size={12} color="#64748b" />
                          <span>{e.camara_nombre || 'Acceso Principal'}</span>
                        </div>
                      </td>

                      {/* Fecha y Hora */}
                      <td style={{ padding: '10px 16px', color: '#334155' }}>
                        <div style={{ fontWeight: 700 }}>
                          {new Date(e.fecha_hora_ingreso || e.fecha_hora || Date.now()).toLocaleTimeString()}
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          {new Date(e.fecha_hora_ingreso || e.fecha_hora || Date.now()).toLocaleDateString()}
                        </div>
                      </td>

                      {/* Confianza */}
                      <td style={{ padding: '10px 16px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#0284c7' }}>
                          OCR: {e.confianza_ocr ? `${(e.confianza_ocr * 100).toFixed(0)}%` : 'N/A'}
                        </div>
                        <div style={{ fontSize: '10px', color: '#94a3b8' }}>
                          YOLO: {e.confianza_deteccion ? `${(e.confianza_deteccion * 100).toFixed(0)}%` : '88%'}
                        </div>
                      </td>

                      {/* Acciones */}
                      <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px' }}>
                          <button 
                            onClick={() => { setSelectedEvento(e); setShowModal(true); }} 
                            className="btn btn-secondary" 
                            style={{ padding: '5px 8px', fontSize: '11px', gap: '4px' }}
                            title="Ver detalles completos"
                          >
                            <Eye size={12} />
                            Ver
                          </button>
                          <button 
                            onClick={() => abrirValidador(e)} 
                            className="btn btn-secondary" 
                            style={{ padding: '5px 8px', fontSize: '11px', gap: '4px', color: '#2563eb' }}
                            title="Corregir o validar placa"
                          >
                            <Edit size={12} />
                          </button>
                          <button 
                            onClick={() => handleDeleteIndividual(e.id)} 
                            className="btn btn-danger" 
                            style={{ padding: '5px 8px', fontSize: '11px' }}
                            title="Eliminar registro"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 5. Modal de Inspección Detallada                                    */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {showModal && selectedEvento && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          padding: '20px'
        }}>
          <div 
            className="glass shadow-premium animate-fade-in" 
            style={{ 
              width: '100%', 
              maxWidth: '680px', 
              borderRadius: '14px', 
              padding: '24px',
              border: '1px solid #e2e8f0',
              background: '#ffffff',
              position: 'relative'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Car size={20} color="#2563eb" />
                <h3 style={{ fontSize: '17px', fontWeight: 900, color: '#0f172a' }}>
                  Ficha Técnica del Ingreso #{selectedEvento.id}
                </h3>
              </div>
              <button 
                onClick={() => setShowModal(false)} 
                className="btn btn-secondary" 
                style={{ padding: '4px 8px', fontSize: '12px' }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px', marginBottom: '18px' }}>
              {/* Fotos */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', marginBottom: '4px' }}>Foto de Ingreso (Vehículo)</div>
                  <div style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid #cbd5e1', height: '150px', backgroundColor: '#0f172a' }}>
                    <img 
                      src={getMediaUrl(selectedEvento.ruta_imagen_ingreso || selectedEvento.imagen_vehiculo_path)} 
                      alt="Vehículo" 
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', marginBottom: '4px' }}>Recorte de Placa LPR</div>
                  <div style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid #cbd5e1', height: '75px', backgroundColor: '#0f172a' }}>
                    <img 
                      src={getMediaUrl(selectedEvento.ruta_imagen_placa || selectedEvento.imagen_placa_path || selectedEvento.ruta_imagen_ingreso)} 
                      alt="Recorte Placa" 
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  </div>
                </div>
              </div>

              {/* Datos de Detección */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ padding: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#64748b' }}>Placa Reconocida</span>
                  <div style={{ fontSize: '24px', fontWeight: 900, color: '#0f172a', letterSpacing: '1px' }}>
                    {selectedEvento.validado_manualmente ? selectedEvento.placa_validada : (selectedEvento.placa_reconocida || selectedEvento.placa)}
                  </div>
                  <div style={{ fontSize: '11px', color: '#0284c7', fontWeight: 700, marginTop: '2px' }}>
                    Confianza OCR: {selectedEvento.confianza_ocr ? `${(selectedEvento.confianza_ocr * 100).toFixed(1)}%` : 'N/A'} • YOLO: {selectedEvento.confianza_deteccion ? `${(selectedEvento.confianza_deteccion * 100).toFixed(0)}%` : '88%'}
                  </div>
                </div>

                {selectedEvento.estado_validacion === 'autorizado' && (
                  <div style={{ padding: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px' }}>
                    <span style={{ fontSize: '11px', color: '#16a34a', fontWeight: 800 }}>✓ VEHÍCULO DE LISTA BLANCA</span>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#0f172a', marginTop: '2px' }}>{selectedEvento.propietario}</div>
                    <div style={{ fontSize: '11px', color: '#475569' }}>{selectedEvento.departamento} • {selectedEvento.tipo_vehiculo || 'Institucional'}</div>
                  </div>
                )}

                {selectedEvento.estado_validacion === 'alerta' && (
                  <div style={{ padding: '12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px' }}>
                    <span style={{ fontSize: '11px', color: '#ef4444', fontWeight: 800 }}>⚠️ VEHÍCULO EN LISTA NEGRA</span>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: '#991b1b', marginTop: '2px' }}>{selectedEvento.alerta_motivo}</div>
                    <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 700 }}>Nivel: {selectedEvento.nivel_alerta}</div>
                  </div>
                )}

                <div style={{ fontSize: '11px', color: '#64748b', display: 'flex', flexDirection: 'column', gap: '3px', marginTop: 'auto' }}>
                  <div><strong>Cámara:</strong> {selectedEvento.camara_nombre || 'Acceso Principal'}</div>
                  <div><strong>Ubicación:</strong> {selectedEvento.camara_ubicacion || 'Garita de Entrada'}</div>
                  <div><strong>Fecha y Hora:</strong> {new Date(selectedEvento.fecha_hora_ingreso || selectedEvento.fecha_hora || Date.now()).toLocaleString()}</div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #e2e8f0', paddingTop: '12px' }}>
              <button 
                onClick={() => handleDeleteIndividual(selectedEvento.id)} 
                className="btn btn-danger" 
                style={{ fontSize: '11px', gap: '4px' }}
              >
                <Trash2 size={13} />
                Eliminar Registro
              </button>
              
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  onClick={() => { setShowModal(false); abrirValidador(selectedEvento); }} 
                  className="btn btn-primary" 
                  style={{ fontSize: '11px', gap: '4px' }}
                >
                  <Edit size={13} />
                  Corregir Placa Manualmente
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 6. Modal de Validación / Corrección Manual                         */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {showValidador && selectedEvento && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1100,
          padding: '20px'
        }}>
          <div className="glass shadow-premium" style={{ width: '100%', maxWidth: '440px', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 800, marginBottom: '14px', color: '#0f172a' }}>
              Corregir Placa Manualmente
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid #cbd5e1', height: '90px', background: '#0f172a' }}>
                <img 
                  src={getMediaUrl(selectedEvento.ruta_imagen_placa || selectedEvento.imagen_placa_path || selectedEvento.ruta_imagen_ingreso)} 
                  alt="Placa" 
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  Placa Validada (Formato Ecuador: AAA-1234):
                </label>
                <input 
                  type="text" 
                  className="input" 
                  value={placaManual}
                  onChange={(e) => setPlacaManual(e.target.value)}
                  style={{ textTransform: 'uppercase', fontSize: '18px', fontWeight: 900, textAlign: 'center', letterSpacing: '2px' }}
                  autoFocus
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '6px' }}>
                <button onClick={() => setShowValidador(false)} className="btn btn-secondary">
                  Cancelar
                </button>
                <button onClick={guardarValidacion} className="btn btn-primary" style={{ fontWeight: 800 }}>
                  Guardar Validación
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default Historial;
