import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { 
  ShieldCheck, 
  ShieldAlert, 
  Trash2, 
  Plus, 
  Users, 
  UserPlus, 
  FileText, 
  UserCheck
} from 'lucide-react';

interface BlacklistItem {
  id: number;
  placa: string;
  motivo: string;
  nivel_alerta: 'CRITICA' | 'ALTA' | 'MEDIA';
  fecha_registro: string;
}

interface WhitelistItem {
  id: number;
  placa: string;
  propietario: string;
  departamento?: string;
  tipo_vehiculo?: string;
  activo: boolean;
  fecha_registro: string;
}

interface UserItem {
  id: number;
  username: string;
  nombre: string;
  rol: 'Admin' | 'Operador';
  activo: boolean;
  created_at: string;
}

const AdminPanel: React.FC = () => {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');

  const [activeTab, setActiveTab] = useState<'autorizados' | 'blacklist' | 'users' | 'camaras'>(
    tabParam === 'blacklist' ? 'blacklist' :
    tabParam === 'usuarios' || tabParam === 'users' ? 'users' :
    tabParam === 'camaras' ? 'camaras' : 'autorizados'
  );

  // Sync tab with URL
  useEffect(() => {
    if (tabParam === 'blacklist') setActiveTab('blacklist');
    else if (tabParam === 'usuarios' || tabParam === 'users') setActiveTab('users');
    else if (tabParam === 'camaras') setActiveTab('camaras');
    else if (tabParam === 'autorizados') setActiveTab('autorizados');
  }, [tabParam]);

  const switchTab = (tab: 'autorizados' | 'blacklist' | 'users' | 'camaras') => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  // Whitelist (Lista Blanca) state
  const [whitelist, setWhitelist] = useState<WhitelistItem[]>([]);
  const [whitePlaca, setWhitePlaca] = useState('');
  const [whitePropietario, setWhitePropietario] = useState('');
  const [whiteDepto, setWhiteDepto] = useState('');
  const [whiteTipo, setWhiteTipo] = useState('Institucional');
  const [whiteError, setWhiteError] = useState<string | null>(null);
  const [whiteSuccess, setWhiteSuccess] = useState<string | null>(null);

  // Blacklist state
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>([]);
  const [placa, setPlaca] = useState('');
  const [motivo, setMotivo] = useState('');
  const [nivelAlerta, setNivelAlerta] = useState<'CRITICA' | 'ALTA' | 'MEDIA'>('ALTA');
  const [blacklistError, setBlacklistError] = useState<string | null>(null);
  const [blacklistSuccess, setBlacklistSuccess] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<UserItem[]>([]);
  const [cameras, setCameras] = useState<any[]>([]);
  const [camNombre, setCamNombre] = useState('');
  const [camIP, setCamIP] = useState('');
  const [camRTSP, setCamRTSP] = useState('');
  const [camUbicacion, setCamUbicacion] = useState('');
  const [camError, setCamError] = useState<string | null>(null);
  const [camSuccess, setCamSuccess] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nombre, setNombre] = useState('');
  const [rol, setRol] = useState<'Admin' | 'Operador'>('Operador');
  const [userError, setUserError] = useState<string | null>(null);
  const [userSuccess, setUserSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (user?.rol === 'Admin') {
      loadWhitelist();
      loadBlacklist();
      loadUsers();
      loadCameras();
    }
  }, [user]);

  const loadWhitelist = async () => {
    try {
      const res = await api.get('/vehiculos-autorizados');
      setWhitelist(res.data);
    } catch (err) {
      console.error('Error al cargar lista blanca:', err);
    }
  };

  const loadCameras = async () => {
    try {
      const res = await api.get('/camaras');
      setCameras(res.data);
    } catch (err) {
      console.error('Error al cargar cámaras:', err);
    }
  };

  const loadBlacklist = async () => {
    try {
      const res = await api.get('/blacklist');
      setBlacklist(res.data);
    } catch (err) {
      console.error('Error al cargar lista negra:', err);
    }
  };

  const loadUsers = async () => {
    try {
      const res = await api.get('/usuarios');
      setUsers(res.data);
    } catch (err) {
      console.error('Error al cargar usuarios:', err);
    }
  };

  // Handlers para Lista Blanca
  const handleAddWhitelist = async (e: React.FormEvent) => {
    e.preventDefault();
    setWhiteError(null);
    setWhiteSuccess(null);

    if (!whitePlaca.trim() || !whitePropietario.trim()) {
      setWhiteError('La placa y el propietario son obligatorios.');
      return;
    }

    try {
      await api.post('/vehiculos-autorizados', {
        placa: whitePlaca.toUpperCase().trim(),
        propietario: whitePropietario.trim(),
        departamento: whiteDepto.trim() || null,
        tipo_vehiculo: whiteTipo.trim() || null,
      });
      setWhiteSuccess('Vehículo registrado en la Lista Blanca exitosamente.');
      setWhitePlaca('');
      setWhitePropietario('');
      setWhiteDepto('');
      setWhiteTipo('Institucional');
      loadWhitelist();
    } catch (err: any) {
      setWhiteError(err.response?.data?.error || 'Error al registrar vehículo autorizado.');
    }
  };

  const handleDeleteWhitelist = async (id: number) => {
    if (!window.confirm('¿Está seguro de retirar este vehículo de la Lista Blanca?')) return;

    try {
      await api.delete(`/vehiculos-autorizados/${id}`);
      loadWhitelist();
    } catch (err) {
      alert('Error al retirar vehículo de la lista blanca.');
    }
  };

  // Handlers para Lista Negra
  const handleAddBlacklist = async (e: React.FormEvent) => {
    e.preventDefault();
    setBlacklistError(null);
    setBlacklistSuccess(null);

    if (!placa.trim() || !motivo.trim()) {
      setBlacklistError('La placa y el motivo son requeridos.');
      return;
    }

    try {
      await api.post('/blacklist', {
        placa: placa.toUpperCase().trim(),
        motivo: motivo.trim(),
        nivel_alerta: nivelAlerta
      });
      setBlacklistSuccess('Vehículo registrado en la lista negra exitosamente.');
      setPlaca('');
      setMotivo('');
      setNivelAlerta('ALTA');
      loadBlacklist();
    } catch (err: any) {
      setBlacklistError(err.response?.data?.error || 'Error al guardar en lista negra.');
    }
  };

  const handleDeleteBlacklist = async (id: number) => {
    if (!window.confirm('¿Está seguro de retirar este vehículo de la lista negra?')) return;

    try {
      await api.delete(`/blacklist/${id}`);
      loadBlacklist();
    } catch (err) {
      alert('Error al eliminar vehículo de la lista negra.');
    }
  };

  // Handlers para Usuarios
  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserError(null);
    setUserSuccess(null);

    if (!username.trim() || !password.trim() || !nombre.trim() || !rol) {
      setUserError('Todos los campos de usuario son requeridos.');
      return;
    }

    try {
      await api.post('/usuarios', {
        username: username.trim().toLowerCase(),
        password,
        nombre: nombre.trim(),
        rol
      });
      setUserSuccess('Nuevo operador registrado correctamente.');
      setUsername('');
      setPassword('');
      setNombre('');
      setRol('Operador');
      loadUsers();
    } catch (err: any) {
      setUserError(err.response?.data?.error || 'Error al guardar usuario.');
    }
  };

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    setCamError(null);
    setCamSuccess(null);

    if (!camNombre.trim() || !camIP.trim() || !camRTSP.trim()) {
      setCamError('Nombre, IP y URL RTSP son requeridos.');
      return;
    }

    try {
      await api.post('/camaras', {
        nombre: camNombre.trim(),
        ip: camIP.trim(),
        rtsp_url: camRTSP.trim(),
        ubicacion: camUbicacion.trim(),
        activa: 1
      });
      setCamSuccess('Cámara registrada correctamente.');
      setCamNombre(''); setCamIP(''); setCamRTSP(''); setCamUbicacion('');
      loadCameras();
    } catch (err: any) {
      setCamError(err.response?.data?.error || 'Error al guardar cámara.');
    }
  };

  const handleDeleteCamera = async (id: number) => {
    if (!window.confirm('¿Eliminar esta cámara?')) return;
    try {
      await api.delete(`/camaras/${id}`);
      loadCameras();
    } catch (err) {
      alert('Error al eliminar cámara.');
    }
  };

  if (user?.rol !== 'Admin') {
    return (
      <div style={{ textAlign: 'center', padding: '100px 20px', color: 'var(--alert-critica)' }}>
        <h2>Acceso Restringido</h2>
        <p>Esta sección requiere permisos de Administrador del ECU 911.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '24px' }}>
      
      {/* Título y Descripción */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 900, color: '#0f172a', letterSpacing: '-0.3px' }}>
            Panel de Administración y Control de Acceso
          </h2>
          <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
            Gestión centralizada de Lista Blanca (autorizados), Lista Negra (alertas), operadores y canales RTSP.
          </p>
        </div>
      </div>

      {/* Selector de Pestañas */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '2px solid #e2e8f0', paddingBottom: '8px' }}>
        
        {/* Tab Lista Blanca */}
        <button 
          onClick={() => switchTab('autorizados')} 
          className="btn" 
          style={{ 
            background: activeTab === 'autorizados' ? '#f0fdf4' : 'transparent',
            color: activeTab === 'autorizados' ? '#16a34a' : '#64748b',
            border: activeTab === 'autorizados' ? '1px solid #bbf7d0' : '1px solid transparent',
            fontWeight: 800,
            fontSize: '13px',
            gap: '8px',
            borderRadius: '8px',
            padding: '8px 16px'
          }}
        >
          <ShieldCheck size={18} color={activeTab === 'autorizados' ? '#16a34a' : '#64748b'} />
          Lista Blanca ({whitelist.length})
        </button>

        {/* Tab Lista Negra */}
        <button 
          onClick={() => switchTab('blacklist')} 
          className="btn" 
          style={{ 
            background: activeTab === 'blacklist' ? '#fef2f2' : 'transparent',
            color: activeTab === 'blacklist' ? '#ef4444' : '#64748b',
            border: activeTab === 'blacklist' ? '1px solid #fecaca' : '1px solid transparent',
            fontWeight: 800,
            fontSize: '13px',
            gap: '8px',
            borderRadius: '8px',
            padding: '8px 16px'
          }}
        >
          <ShieldAlert size={18} color={activeTab === 'blacklist' ? '#ef4444' : '#64748b'} />
          Lista Negra ({blacklist.length})
        </button>

        {/* Tab Operadores */}
        <button 
          onClick={() => switchTab('users')} 
          className="btn" 
          style={{ 
            background: activeTab === 'users' ? '#eff6ff' : 'transparent',
            color: activeTab === 'users' ? '#2563eb' : '#64748b',
            border: activeTab === 'users' ? '1px solid #bfdbfe' : '1px solid transparent',
            fontWeight: 800,
            fontSize: '13px',
            gap: '8px',
            borderRadius: '8px',
            padding: '8px 16px'
          }}
        >
          <Users size={18} color={activeTab === 'users' ? '#2563eb' : '#64748b'} />
          Gestión de Operadores ({users.length})
        </button>

        {/* Tab Cámaras */}
        <button 
          onClick={() => switchTab('camaras')} 
          className="btn" 
          style={{ 
            background: activeTab === 'camaras' ? '#f8fafc' : 'transparent',
            color: activeTab === 'camaras' ? '#0f172a' : '#64748b',
            border: activeTab === 'camaras' ? '1px solid #cbd5e1' : '1px solid transparent',
            fontWeight: 800,
            fontSize: '13px',
            gap: '8px',
            borderRadius: '8px',
            padding: '8px 16px'
          }}
        >
          <FileText size={18} color={activeTab === 'camaras' ? '#0f172a' : '#64748b'} />
          Canales RTSP ({cameras.length})
        </button>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 1. PESTAÑA: LISTA BLANCA (Vehículos Autorizados)                    */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === 'autorizados' && (
        <div style={{ display: 'grid', gridTemplateColumns: '4fr 6fr', gap: '24px' }}>
          
          {/* Formulario Registrar en Lista Blanca */}
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', height: 'fit-content', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#16a34a', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={20} color="#16a34a" />
              <span>Registrar Vehículo en Lista Blanca</span>
            </h3>

            <form onSubmit={handleAddWhitelist} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {whiteError && <div style={{ color: '#ef4444', fontSize: '12px', background: '#fef2f2', border: '1px solid #fecaca', padding: '10px', borderRadius: '6px' }}>{whiteError}</div>}
              {whiteSuccess && <div style={{ color: '#16a34a', fontSize: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '10px', borderRadius: '6px' }}>{whiteSuccess}</div>}

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  Placa Vehicular *
                </label>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="Ej. PBA5678 o TCA-9012"
                  value={whitePlaca}
                  onChange={(e) => setWhitePlaca(e.target.value)}
                  style={{ textTransform: 'uppercase', fontWeight: 700, letterSpacing: '1px' }}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  Propietario / Funcionario *
                </label>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="Ej. Ing. Carlos Medina / Coordinador Zonal"
                  value={whitePropietario}
                  onChange={(e) => setWhitePropietario(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  Departamento / Área
                </label>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="Ej. Operaciones / Dirección / Sala de Crisis"
                  value={whiteDepto}
                  onChange={(e) => setWhiteDepto(e.target.value)}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>
                  Tipo de Vehículo
                </label>
                <select 
                  className="input" 
                  value={whiteTipo}
                  onChange={(e) => setWhiteTipo(e.target.value)}
                >
                  <option value="Institucional">Vehículo Institucional (Oficial)</option>
                  <option value="Funcionario">Funcionario / Directivo</option>
                  <option value="Servicio de Emergencia">Servicio de Emergencia (Ambulancia / Policía / Bomberos)</option>
                  <option value="Visita Autorizada">Visita Autorizada / Proveedor</option>
                </select>
              </div>

              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '6px', background: '#16a34a', borderColor: '#16a34a', color: 'white', fontWeight: 800 }}>
                <Plus size={16} />
                Guardar en Lista Blanca
              </button>
            </form>
          </div>

          {/* Tabla de Vehículos Autorizados */}
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#0f172a', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <UserCheck size={18} color="#16a34a" />
              <span>Vehículos Autorizados Registrados ({whitelist.length})</span>
            </h3>
            
            {whitelist.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#64748b' }}>
                No hay vehículos en la Lista Blanca actualmente.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 800 }}>
                      <th style={{ padding: '10px' }}>Placa</th>
                      <th style={{ padding: '10px' }}>Propietario</th>
                      <th style={{ padding: '10px' }}>Área / Depto</th>
                      <th style={{ padding: '10px' }}>Tipo</th>
                      <th style={{ padding: '10px', textAlign: 'center' }}>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {whitelist.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '10px' }}>
                          <span style={{ fontWeight: 900, color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '3px 8px', borderRadius: '4px', letterSpacing: '0.5px' }}>
                            {item.placa}
                          </span>
                        </td>
                        <td style={{ padding: '10px', fontWeight: 700, color: '#0f172a' }}>{item.propietario}</td>
                        <td style={{ padding: '10px', color: '#64748b' }}>{item.departamento || 'N/A'}</td>
                        <td style={{ padding: '10px', color: '#475569', fontSize: '11px' }}>{item.tipo_vehiculo || 'Institucional'}</td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleDeleteWhitelist(item.id)} 
                            className="btn btn-danger" 
                            style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '11px', gap: '4px' }}
                            title="Retirar de lista blanca"
                          >
                            <Trash2 size={13} />
                            Eliminar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 2. PESTAÑA: LISTA NEGRA (Vehículos Sospechosos / Alertas)          */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === 'blacklist' && (
        <div style={{ display: 'grid', gridTemplateColumns: '4fr 6fr', gap: '24px' }}>
          {/* Formulario Agregar */}
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', height: 'fit-content', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#ef4444', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={20} color="#ef4444" />
              <span>Registrar Placa en Lista Negra (Alerta)</span>
            </h3>

            <form onSubmit={handleAddBlacklist} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {blacklistError && <div style={{ color: '#ef4444', fontSize: '12px', background: '#fef2f2', border: '1px solid #fecaca', padding: '10px', borderRadius: '6px' }}>{blacklistError}</div>}
              {blacklistSuccess && <div style={{ color: '#16a34a', fontSize: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '10px', borderRadius: '6px' }}>{blacklistSuccess}</div>}

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Placa Vehicular *</label>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="Ej. PBA-1234 o TBG-987"
                  value={placa}
                  onChange={(e) => setPlaca(e.target.value)}
                  style={{ textTransform: 'uppercase', fontWeight: 700, letterSpacing: '1px' }}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Nivel de Alerta</label>
                <select 
                  className="input" 
                  value={nivelAlerta}
                  onChange={(e: any) => setNivelAlerta(e.target.value)}
                >
                  <option value="CRITICA">CRÍTICA (Robo / Delito Flagrante)</option>
                  <option value="ALTA">ALTA (Vehículo Sospechoso / Encargo Judicial)</option>
                  <option value="MEDIA">MEDIA (Acceso No Autorizado / Restringido)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Motivo de la Alerta *</label>
                <textarea 
                  className="input" 
                  placeholder="Detalle los motivos institucionales del encargo o alerta..."
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  style={{ minHeight: '80px', fontFamily: 'inherit', resize: 'vertical' }}
                  required
                />
              </div>

              <button type="submit" className="btn btn-danger" style={{ width: '100%', marginTop: '6px', fontWeight: 800 }}>
                <Plus size={16} />
                Guardar en Lista Negra
              </button>
            </form>
          </div>

          {/* Tabla de Listado */}
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#0f172a', marginBottom: '16px' }}>Placas Registradas en Lista Negra ({blacklist.length})</h3>
            
            {blacklist.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#64748b' }}>
                No hay vehículos en la lista negra actualmente.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 800 }}>
                      <th style={{ padding: '10px' }}>Placa</th>
                      <th style={{ padding: '10px' }}>Nivel</th>
                      <th style={{ padding: '10px' }}>Motivo de Alerta</th>
                      <th style={{ padding: '10px', textAlign: 'center' }}>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blacklist.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '10px' }}>
                          <span style={{ fontWeight: 900, color: '#ef4444', background: '#fef2f2', border: '1px solid #fecaca', padding: '3px 8px', borderRadius: '4px', letterSpacing: '0.5px' }}>
                            {item.placa}
                          </span>
                        </td>
                        <td style={{ padding: '10px' }}>
                          <span style={{ 
                            fontSize: '10px', 
                            fontWeight: 800, 
                            color: 'white',
                            backgroundColor: item.nivel_alerta === 'CRITICA' ? '#ef4444' : item.nivel_alerta === 'ALTA' ? '#f97316' : '#eab308',
                            padding: '3px 8px',
                            borderRadius: '4px'
                          }}>
                            {item.nivel_alerta}
                          </span>
                        </td>
                        <td style={{ padding: '10px', color: '#334155', fontWeight: 600 }}>{item.motivo}</td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <button 
                            onClick={() => handleDeleteBlacklist(item.id)} 
                            className="btn btn-danger" 
                            style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '11px', gap: '4px' }}
                            title="Eliminar de lista negra"
                          >
                            <Trash2 size={13} />
                            Eliminar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 3. PESTAÑA: GESTIÓN DE OPERADORES                                  */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === 'users' && (
        <div style={{ display: 'grid', gridTemplateColumns: '4fr 6fr', gap: '24px' }}>
          {/* Formulario Crear Operador */}
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', height: 'fit-content', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#2563eb', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <UserPlus size={20} color="#2563eb" />
              <span>Registrar Nuevo Operador</span>
            </h3>

            <form onSubmit={handleAddUser} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {userError && <div style={{ color: '#ef4444', fontSize: '12px', background: '#fef2f2', border: '1px solid #fecaca', padding: '10px', borderRadius: '6px' }}>{userError}</div>}
              {userSuccess && <div style={{ color: '#16a34a', fontSize: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '10px', borderRadius: '6px' }}>{userSuccess}</div>}

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Nombre Completo</label>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="Ej. Ing. Juan Pérez"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Usuario Institucional</label>
                <input 
                  type="text" 
                  className="input" 
                  placeholder="Ej. jperez"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Contraseña de Acceso</label>
                <input 
                  type="password" 
                  className="input" 
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Rol Asignado</label>
                <select 
                  className="input" 
                  value={rol}
                  onChange={(e: any) => setRol(e.target.value)}
                >
                  <option value="Operador">Operador (Monitoreo e Historial)</option>
                  <option value="Admin">Administrador (Control Total)</option>
                </select>
              </div>

              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '6px', fontWeight: 800 }}>
                <Plus size={16} />
                Registrar Usuario
              </button>
            </form>
          </div>

          {/* Listado de Operadores */}
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#0f172a', marginBottom: '16px' }}>Usuarios del Sistema ({users.length})</h3>
            
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 800 }}>
                    <th style={{ padding: '10px' }}>Nombre</th>
                    <th style={{ padding: '10px' }}>Usuario</th>
                    <th style={{ padding: '10px' }}>Rol</th>
                    <th style={{ padding: '10px' }}>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '10px', fontWeight: 700, color: '#0f172a' }}>{u.nombre}</td>
                      <td style={{ padding: '10px', color: '#64748b' }}>{u.username}</td>
                      <td style={{ padding: '10px' }}>
                        <span style={{ 
                          fontSize: '10px', 
                          fontWeight: 800, 
                          color: u.rol === 'Admin' ? '#2563eb' : '#16a34a',
                          backgroundColor: u.rol === 'Admin' ? '#eff6ff' : '#f0fdf4',
                          border: `1px solid ${u.rol === 'Admin' ? '#bfdbfe' : '#bbf7d0'}`,
                          padding: '3px 8px',
                          borderRadius: '4px'
                        }}>
                          {u.rol.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '10px' }}>
                        <span style={{ color: u.activo ? '#16a34a' : '#ef4444', fontWeight: 700 }}>
                          {u.activo ? '● Activo' : '○ Inactivo'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 4. PESTAÑA: CANALES RTSP                                           */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === 'camaras' && (
        <div style={{ display: 'grid', gridTemplateColumns: '4fr 6fr', gap: '24px' }}>
          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', height: 'fit-content', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#0f172a', marginBottom: '16px' }}>Registrar Cámara (RTSP)</h3>
            <form onSubmit={handleAddCamera} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {camError && <div style={{ color: '#ef4444', fontSize: '12px', background: '#fef2f2', border: '1px solid #fecaca', padding: '10px', borderRadius: '6px' }}>{camError}</div>}
              {camSuccess && <div style={{ color: '#16a34a', fontSize: '12px', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '10px', borderRadius: '6px' }}>{camSuccess}</div>}

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Nombre</label>
                <input className="input" placeholder="Ej. Cámara Garita Principal" value={camNombre} onChange={e => setCamNombre(e.target.value)} required />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>IP de la Cámara</label>
                <input className="input" placeholder="Ej. 10.126.9.104" value={camIP} onChange={e => setCamIP(e.target.value)} required />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>URL RTSP</label>
                <input className="input" placeholder="rtsp://user:pass@10.126.9.104:554/h265/ch1/main/av_stream" value={camRTSP} onChange={e => setCamRTSP(e.target.value)} required />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#334155', marginBottom: '6px' }}>Ubicación</label>
                <input className="input" placeholder="Ej. Acceso Principal Zonal 3" value={camUbicacion} onChange={e => setCamUbicacion(e.target.value)} />
              </div>

              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '6px', fontWeight: 800 }}>Guardar Cámara</button>
            </form>
          </div>

          <div className="glass shadow-premium" style={{ padding: '24px', borderRadius: '12px', border: '1px solid #e2e8f0', background: '#ffffff' }}>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#0f172a', marginBottom: '16px' }}>Cámaras Registradas ({cameras.length})</h3>
            {cameras.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#64748b' }}>No hay cámaras registradas.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 800 }}>
                      <th style={{ padding: '10px' }}>Nombre</th>
                      <th style={{ padding: '10px' }}>IP</th>
                      <th style={{ padding: '10px' }}>RTSP URL</th>
                      <th style={{ padding: '10px' }}>Ubicación</th>
                      <th style={{ padding: '10px', textAlign: 'center' }}>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cameras.map((c) => (
                      <tr key={c.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '10px', fontWeight: 700, color: '#0f172a' }}>{c.nombre}</td>
                        <td style={{ padding: '10px', color: '#2563eb', fontWeight: 600 }}>{c.ip}</td>
                        <td style={{ padding: '10px', color: '#64748b', fontSize: '11px', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.rtsp_url}>{c.rtsp_url}</td>
                        <td style={{ padding: '10px', color: '#475569' }}>{c.ubicacion}</td>
                        <td style={{ padding: '10px', textAlign: 'center' }}>
                          <button onClick={() => handleDeleteCamera(c.id)} className="btn btn-danger" style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '11px' }}>Eliminar</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
};

export default AdminPanel;
