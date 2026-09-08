import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import io from 'socket.io-client';
import api, { API_URL } from '../services/api';
import { 
  Tv, 
  Video, 
  ShieldCheck, 
  ShieldAlert, 
  History, 
  Users, 
  LogOut, 
  ChevronLeft, 
  ChevronRight,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface AppSidebarProps {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean | ((prev: boolean) => boolean)) => void;
}

interface CameraChannel {
  id: number;
  nombre: string;
  ip: string;
  rtsp_url: string;
  activa: boolean | number;
  estado?: string;
}

const AppSidebar: React.FC<AppSidebarProps> = ({ collapsed, setCollapsed }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [registeredCameras, setRegisteredCameras] = useState<CameraChannel[]>([]);
  const [monitoreoSubmenuOpen, setMonitoreoSubmenuOpen] = useState(true);

  useEffect(() => {
    const loadCameras = async () => {
      try {
        const res = await api.get('/camaras');
        if (res.data && Array.isArray(res.data)) {
          setRegisteredCameras(res.data);
        }
      } catch (e) {
        // Silently handle
      }
    };
    loadCameras();

    const socketUrl = API_URL.replace(/\/api\/?$/, '');
    const socket = io(socketUrl);

    socket.on('camara_creada', (newCam: CameraChannel) => {
      setRegisteredCameras(prev => [newCam, ...prev.filter(c => c.id !== newCam.id)]);
    });
    socket.on('camara_actualizada', (updCam: CameraChannel) => {
      setRegisteredCameras(prev => prev.map(c => c.id === updCam.id ? { ...c, ...updCam } : c));
    });
    socket.on('camara_eliminada', (delData: { id: number }) => {
      setRegisteredCameras(prev => prev.filter(c => c.id !== delData.id));
    });
    socket.on('camara_estado_cambiado', (stData: CameraChannel) => {
      setRegisteredCameras(prev => prev.map(c => c.id === stData.id ? { ...c, ...stData } : c));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isAdmin = user?.rol === 'Admin';

  const navItems = [
    {
      name: 'Registro de Canal',
      path: '/canales',
      icon: Video,
      badge: 'RTSP',
      badgeColor: '#0284c7',
      adminOnly: true,
    },
    {
      name: 'Monitoreo en Vivo',
      path: '/',
      icon: Tv,
      badge: '30 FPS',
      badgeColor: '#16a34a',
      adminOnly: false,
    },
    {
      name: 'Vehículos Autorizados',
      path: '/admin?tab=autorizados',
      activeCheck: (loc: string) => loc.includes('tab=autorizados') || (loc === '/admin' && !loc.includes('tab=')),
      icon: ShieldCheck,
      badge: null,
      adminOnly: true,
    },
    {
      name: 'Lista Negra',
      path: '/admin?tab=blacklist',
      activeCheck: (loc: string) => loc.includes('tab=blacklist'),
      icon: ShieldAlert,
      badge: 'ALERTA',
      badgeColor: '#ef4444',
      adminOnly: true,
    },
    {
      name: 'Historial de Ingresos',
      path: '/historial',
      icon: History,
      badge: null,
      adminOnly: false,
    },
    {
      name: 'Gestión de Usuarios',
      path: '/admin?tab=usuarios',
      activeCheck: (loc: string) => loc.includes('tab=usuarios'),
      icon: Users,
      badge: null,
      adminOnly: true,
    },
  ];

  return (
    <aside
      style={{
        width: collapsed ? '74px' : '260px',
        minWidth: collapsed ? '74px' : '260px',
        height: '100vh',
        backgroundColor: '#121214',
        borderRight: '1px solid #232326',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'sticky',
        top: 0,
        left: 0,
        zIndex: 100,
        userSelect: 'none',
        boxShadow: '2px 0 12px rgba(0, 0, 0, 0.35)',
      }}
    >
      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* 1. Header / Logo del Centro de Control ECU 911 (Negro Grafito Neutro) */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      <div>
        <div
          style={{
            height: '56px',
            padding: collapsed ? '0 12px' : '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'space-between',
            borderBottom: '1px solid #232326',
            backgroundColor: '#0a0a0c',
          }}
        >
          {!collapsed ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '6px',
                  background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(239, 68, 68, 0.4)',
                  color: 'white',
                  fontWeight: 900,
                  fontSize: '12px',
                }}
              >
                911
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 900, color: '#f8fafc', letterSpacing: '0.5px', lineHeight: 1.1 }}>
                  ECU 911 VIGS
                </div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: '#a1a1aa', letterSpacing: '0.8px' }}>
                  CENTRO DE CONTROL
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '6px',
                background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 2px 8px rgba(239, 68, 68, 0.4)',
                color: 'white',
                fontWeight: 900,
                fontSize: '12px',
              }}
              title="ECU 911 - Centro de Control"
            >
              911
            </div>
          )}

          {/* Botón de Colapsar / Expandir */}
          <button
            onClick={() => setCollapsed(prev => !prev)}
            style={{
              background: '#18181b',
              border: '1px solid #2e2e33',
              borderRadius: '6px',
              color: '#a1a1aa',
              cursor: 'pointer',
              padding: '5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s ease',
            }}
            title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
            onMouseEnter={e => {
              e.currentTarget.style.color = '#ffffff';
              e.currentTarget.style.background = '#232326';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = '#a1a1aa';
              e.currentTarget.style.background = '#18181b';
            }}
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>
        </div>

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* 2. Menú de Navegación Exclusivo                                     */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        <div style={{ padding: '14px 8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {!collapsed && (
            <div style={{ fontSize: '10px', fontWeight: 800, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.8px', padding: '0 10px 8px' }}>
              Módulos del Sistema
            </div>
          )}

          {navItems.map((item, index) => {
            if (item.adminOnly && !isAdmin) return null;

            const Icon = item.icon;
            const currentFull = location.pathname + location.search;
            const isMonitoreo = item.path === '/';
            const isActive = isMonitoreo
              ? location.pathname === '/' && (!location.search.includes('tab=') && !location.search.includes('canal='))
              : item.activeCheck 
                ? item.activeCheck(currentFull) 
                : location.pathname === item.path && !location.search;

            return (
              <React.Fragment key={index}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <NavLink
                    to={item.path}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: collapsed ? 'center' : 'space-between',
                      padding: collapsed ? '11px 0' : '9px 12px',
                      borderRadius: '6px',
                      color: isActive ? '#ffffff' : '#a1a1aa',
                      backgroundColor: isActive ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                      borderLeft: isActive ? '3px solid #ef4444' : '3px solid transparent',
                      textDecoration: 'none',
                      fontSize: '13px',
                      fontWeight: isActive ? 700 : 500,
                      transition: 'all 0.15s ease',
                    }}
                    title={collapsed ? item.name : undefined}
                    onMouseEnter={e => {
                      if (!isActive) {
                        e.currentTarget.style.backgroundColor = '#1c1c20';
                        e.currentTarget.style.color = '#f4f4f5';
                      }
                    }}
                    onMouseLeave={e => {
                      if (!isActive) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = '#a1a1aa';
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Icon 
                        size={18} 
                        style={{ 
                          color: isActive ? '#ef4444' : '#a1a1aa',
                          flexShrink: 0 
                        }} 
                      />
                      {!collapsed && <span style={{ letterSpacing: '0.2px' }}>{item.name}</span>}
                    </div>

                    {!collapsed && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {item.badge && (
                          <span
                            style={{
                              fontSize: '9px',
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              backgroundColor: item.badgeColor || '#3b82f6',
                              color: 'white',
                              letterSpacing: '0.4px',
                            }}
                          >
                            {item.badge}
                          </span>
                        )}
                        {isMonitoreo && registeredCameras.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setMonitoreoSubmenuOpen(prev => !prev);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: '2px',
                              cursor: 'pointer',
                              color: '#71717a',
                              display: 'flex',
                              alignItems: 'center'
                            }}
                            title="Alternar submenú de canales"
                          >
                            {monitoreoSubmenuOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        )}
                      </div>
                    )}
                  </NavLink>
                </div>

                {/* Submenú de Canales RTSP para Monitoreo en Vivo */}
                {isMonitoreo && !collapsed && monitoreoSubmenuOpen && registeredCameras.length > 0 && (
                  <div
                    style={{
                      marginLeft: '20px',
                      paddingLeft: '10px',
                      borderLeft: '2px solid #27272a',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                      marginTop: '2px',
                      marginBottom: '6px'
                    }}
                  >
                    {/* Canal Local Principal */}
                    <NavLink
                      to="/"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 8px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        textDecoration: 'none',
                        color: location.pathname === '/' && !location.search.includes('canal=') ? '#ffffff' : '#a1a1aa',
                        backgroundColor: location.pathname === '/' && !location.search.includes('canal=') ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
                        fontWeight: location.pathname === '/' && !location.search.includes('canal=') ? 700 : 500,
                        borderLeft: location.pathname === '/' && !location.search.includes('canal=') ? '2px solid #ef4444' : '2px solid transparent',
                      }}
                      onMouseEnter={e => {
                        if (location.search.includes('canal=')) {
                          e.currentTarget.style.backgroundColor = '#1c1c20';
                          e.currentTarget.style.color = '#fff';
                        }
                      }}
                      onMouseLeave={e => {
                        if (location.search.includes('canal=')) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.color = '#a1a1aa';
                        }
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22c55e' }} />
                        <span>Canal Principal (Webcam)</span>
                      </div>
                    </NavLink>

                    {/* Canales RTSP Registrados */}
                    {registeredCameras.map(cam => {
                      const isCamActive = location.pathname === '/' && location.search.includes(`canal=${cam.id}`);
                      const isOnline = Boolean(cam.activa) || cam.estado === 'ACTIVA';

                      return (
                        <NavLink
                          key={cam.id}
                          to={`/?canal=${cam.id}`}
                          title={`${cam.nombre} - ${cam.rtsp_url}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '6px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            textDecoration: 'none',
                            color: isCamActive ? '#ffffff' : '#a1a1aa',
                            backgroundColor: isCamActive ? 'rgba(56, 189, 248, 0.18)' : 'transparent',
                            borderLeft: isCamActive ? '2px solid #38bdf8' : '2px solid transparent',
                            fontWeight: isCamActive ? 700 : 500,
                            transition: 'all 0.15s ease',
                          }}
                          onMouseEnter={e => {
                            if (!isCamActive) {
                              e.currentTarget.style.backgroundColor = '#1c1c20';
                              e.currentTarget.style.color = '#f1f5f9';
                            }
                          }}
                          onMouseLeave={e => {
                            if (!isCamActive) {
                              e.currentTarget.style.backgroundColor = 'transparent';
                              e.currentTarget.style.color = '#a1a1aa';
                            }
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                backgroundColor: isOnline ? '#22c55e' : '#64748b',
                                flexShrink: 0
                              }}
                            />
                            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                              {cam.nombre}
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: '8px',
                              fontWeight: 800,
                              padding: '1px 4px',
                              borderRadius: '3px',
                              backgroundColor: isOnline ? 'rgba(2, 132, 199, 0.25)' : 'rgba(100, 116, 139, 0.2)',
                              color: isOnline ? '#38bdf8' : '#94a3b8',
                              flexShrink: 0
                            }}
                          >
                            RTSP
                          </span>
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* 3. Footer / Perfil del Usuario                                        */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      <div
        style={{
          borderTop: '1px solid #232326',
          padding: collapsed ? '14px 8px' : '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          backgroundColor: '#0a0a0c',
        }}
      >
        {/* Info de Usuario */}
        {!collapsed ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '6px',
                backgroundColor: isAdmin ? 'rgba(239, 68, 68, 0.2)' : 'rgba(2, 132, 199, 0.2)',
                border: `1px solid ${isAdmin ? '#f87171' : '#38bdf8'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: isAdmin ? '#ef4444' : '#38bdf8',
                fontWeight: 800,
                fontSize: '13px',
                flexShrink: 0,
              }}
            >
              {user?.nombre?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.nombre || 'Usuario'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                <span
                  style={{
                    fontSize: '9px',
                    fontWeight: 800,
                    padding: '1px 5px',
                    borderRadius: '3px',
                    backgroundColor: isAdmin ? 'rgba(239, 68, 68, 0.25)' : 'rgba(2, 132, 199, 0.25)',
                    color: isAdmin ? '#fca5a5' : '#7dd3fc',
                  }}
                >
                  {isAdmin ? 'ADMIN' : 'OPERADOR'}
                </span>
                <span style={{ fontSize: '10px', color: '#4ade80', display: 'flex', alignItems: 'center', gap: '3px' }}>
                  ● En línea
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              width: '32px',
              height: '32px',
              margin: '0 auto',
              borderRadius: '6px',
              backgroundColor: isAdmin ? 'rgba(239, 68, 68, 0.2)' : 'rgba(2, 132, 199, 0.2)',
              border: `1px solid ${isAdmin ? '#f87171' : '#38bdf8'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isAdmin ? '#ef4444' : '#38bdf8',
              fontWeight: 800,
              fontSize: '12px',
            }}
            title={`${user?.nombre} (${user?.rol})`}
          >
            {user?.nombre?.charAt(0).toUpperCase() || 'U'}
          </div>
        )}

        {/* Botón de Logout */}
        <button
          onClick={handleLogout}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: '8px',
            padding: '7px 10px',
            backgroundColor: '#18181b',
            border: '1px solid #2e2e33',
            borderRadius: '6px',
            color: '#f87171',
            fontSize: '11px',
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          title={collapsed ? 'Cerrar Sesión' : undefined}
          onMouseEnter={e => {
            e.currentTarget.style.backgroundColor = '#ef4444';
            e.currentTarget.style.color = '#ffffff';
            e.currentTarget.style.borderColor = '#ef4444';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.backgroundColor = '#18181b';
            e.currentTarget.style.color = '#f87171';
            e.currentTarget.style.borderColor = '#2e2e33';
          }}
        >
          <LogOut size={14} />
          {!collapsed && <span>Cerrar Sesión</span>}
        </button>
      </div>
    </aside>
  );
};

export default AppSidebar;
