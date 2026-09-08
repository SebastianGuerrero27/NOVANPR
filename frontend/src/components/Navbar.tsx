import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogOut, LayoutDashboard, History, ShieldAlert, UserCheck } from 'lucide-react';

const Navbar: React.FC = () => {
  const { user, logout } = useAuth();
  const location = useLocation();

  if (!user) return null;

  const isActive = (path: string) => location.pathname === path;

  return (
    <nav className="glass shadow-premium" style={{ borderBottom: '1px solid var(--border-color)', position: 'sticky', top: 0, zIndex: 100 }}>
      <div className="main-content" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px' }}>
        
        {/* Logo/Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Logo ECU 911 Simplificado */}
          <div style={{
            background: 'var(--alert-critica)',
            color: 'white',
            fontWeight: 900,
            fontSize: '18px',
            padding: '6px 12px',
            borderRadius: '6px',
            letterSpacing: '1px',
            boxShadow: '0 0 10px rgba(239, 68, 68, 0.4)'
          }}>
            ECU 911
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'white', letterSpacing: '0.5px' }}>
              ANPR ZONA 3
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              Ambato, Ecuador
            </div>
          </div>
        </div>

        {/* Navigation Links */}
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <Link 
            to="/" 
            className="btn" 
            style={{ 
              background: isActive('/') ? 'rgba(58, 134, 200, 0.15)' : 'transparent',
              color: isActive('/') ? 'var(--accent-cyan)' : 'var(--text-secondary)',
              border: 'none'
            }}
          >
            <LayoutDashboard size={18} />
            Monitoreo en Vivo
          </Link>
          
          <Link 
            to="/historial" 
            className="btn" 
            style={{ 
              background: isActive('/historial') ? 'rgba(58, 134, 200, 0.15)' : 'transparent',
              color: isActive('/historial') ? 'var(--accent-cyan)' : 'var(--text-secondary)',
              border: 'none'
            }}
          >
            <History size={18} />
            Historial de Ingresos
          </Link>

          {user.rol === 'Admin' && (
            <Link 
              to="/admin" 
              className="btn" 
              style={{ 
                background: isActive('/admin') ? 'rgba(58, 134, 200, 0.15)' : 'transparent',
                color: isActive('/admin') ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                border: 'none'
              }}
            >
              <UserCheck size={18} />
              Panel Admin
            </Link>
          )}
        </div>

        {/* User Info and Logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'white' }}>{user.nombre}</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 700, color: user.rol === 'Admin' ? 'var(--accent-cyan)' : 'var(--success)', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px' }}>
              <ShieldAlert size={10} />
              {user.rol.toUpperCase()}
            </div>
          </div>
          
          <button 
            onClick={logout} 
            className="btn btn-secondary" 
            style={{ padding: '8px 12px', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fda4af' }}
            title="Cerrar Sesión"
          >
            <LogOut size={16} />
            Salir
          </button>
        </div>

      </div>
    </nav>
  );
};

export default Navbar;
