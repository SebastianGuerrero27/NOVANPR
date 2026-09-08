import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, User, Activity } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const TopHeader: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isAdmin = user?.rol === 'Admin';

  return (
    <header
      style={{
        height: '56px',
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 90,
        boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.03)',
      }}
    >
      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 1. Título Institucional / Breadcrumb (Sin links ni tabs)            */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: '#fee2e2',
            border: '1px solid #fca5a5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#ef4444',
          }}
        >
          <Activity size={16} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', letterSpacing: '1px', textTransform: 'uppercase' }}>
            SISTEMA ANPR
          </span>
          <span style={{ color: '#cbd5e1' }}>/</span>
          <span style={{ fontSize: '12px', fontWeight: 900, color: '#0f172a', letterSpacing: '0.6px' }}>
            CENTRO DE CONTROL ECU 911
          </span>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 2. Indicadores de Estado, Usuario y Cerrar Sesión                   */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Badge: En Línea */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '16px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #bbf7d0',
            color: '#16a34a',
            fontSize: '11px',
            fontWeight: 800,
            letterSpacing: '0.4px',
          }}
        >
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#16a34a' }} />
          EN LÍNEA
        </div>

        {/* Usuario Tag */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 12px',
            backgroundColor: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: '6px',
            fontSize: '12px',
          }}
        >
          <User size={14} style={{ color: '#64748b' }} />
          <span style={{ fontWeight: 700, color: '#1e293b' }}>
            {user?.username ? `${user.username.toUpperCase()}@ECU911.GOB.EC` : 'ADMIN@ECU911.GOB.EC'}
          </span>
          <span
            style={{
              fontSize: '10px',
              fontWeight: 800,
              padding: '2px 6px',
              borderRadius: '4px',
              backgroundColor: isAdmin ? '#fee2e2' : '#e0f2fe',
              color: isAdmin ? '#dc2626' : '#0369a1',
              border: `1px solid ${isAdmin ? '#fca5a5' : '#bae6fd'}`,
            }}
          >
            {isAdmin ? 'ADMINISTRADOR' : 'OPERADOR'}
          </span>
        </div>

        {/* Cerrar Sesión */}
        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 12px',
            borderRadius: '6px',
            backgroundColor: '#fee2e2',
            border: '1px solid #fca5a5',
            color: '#dc2626',
            fontSize: '11px',
            fontWeight: 800,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.backgroundColor = '#ef4444';
            e.currentTarget.style.color = '#ffffff';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.backgroundColor = '#fee2e2';
            e.currentTarget.style.color = '#dc2626';
          }}
        >
          <LogOut size={13} />
          CERRAR SESIÓN
        </button>
      </div>
    </header>
  );
};

export default TopHeader;
