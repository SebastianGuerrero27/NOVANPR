import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Shield, User, Lock, AlertCircle, Eye, EyeOff, Radio, ArrowRight } from 'lucide-react';
import fondoANPR from '../components/FONDOANPR.jpeg';

const Login: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Por favor complete todos los campos.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await login(username.trim().toLowerCase(), password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Credenciales inválidas o error en el servidor.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundImage: `url(${fondoANPR})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center center',
        backgroundRepeat: 'no-repeat',
        position: 'relative',
        padding: '24px',
        overflow: 'hidden',
      }}
    >
      {/* Overlay Mínimo Sutil (Permite ver el fondo con total claridad) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.12)',
          zIndex: 1,
        }}
      />

      {/* ───────────────────────────────────────────────────────────────────── */}
      {/* Tarjeta de Login Ultra-Transparentada (Glassmorphism Píxel a Píxel)   */}
      {/* ───────────────────────────────────────────────────────────────────── */}
      <div
        className="animate-fade-in"
        style={{
          position: 'relative',
          zIndex: 10,
          width: '100%',
          maxWidth: '430px',
          padding: '42px 36px',
          borderRadius: '24px',
          backgroundColor: 'rgba(15, 23, 42, 0.28)', // Mayor transparencia cristalina
          backdropFilter: 'blur(12px) saturate(180%)',
          WebkitBackdropFilter: 'blur(12px) saturate(180%)',
          border: '1px solid rgba(255, 255, 255, 0.25)',
          boxShadow: '0 30px 60px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.15)',
        }}
      >
        {/* Glow Superior Suave */}
        <div
          style={{
            position: 'absolute',
            top: '-20px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '160px',
            height: '50px',
            background: 'rgba(239, 68, 68, 0.35)',
            filter: 'blur(35px)',
            borderRadius: '50%',
            pointerEvents: 'none',
          }}
        />

        {/* Encabezado y Logo */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          {/* Badge Superior */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 12px',
              borderRadius: '20px',
              backgroundColor: 'rgba(255, 255, 255, 0.12)',
              border: '1px solid rgba(255, 255, 255, 0.28)',
              color: '#ffffff',
              fontSize: '10px',
              fontWeight: 800,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              marginBottom: '14px',
              backdropFilter: 'blur(4px)',
            }}
          >
            <Radio size={12} color="#22c55e" className="animate-pulse" />
            ECU 911 • CENTRO DE CONTROL
          </div>

          <div
            style={{
              width: '54px',
              height: '54px',
              margin: '0 auto 12px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.95) 0%, rgba(185, 28, 28, 0.95) 100%)',
              border: '1px solid rgba(255, 255, 255, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 6px 20px rgba(239, 68, 68, 0.45)',
              color: '#ffffff',
            }}
          >
            <Shield size={26} />
          </div>

          <h1
            style={{
              fontSize: '23px',
              fontWeight: 900,
              color: '#ffffff',
              letterSpacing: '0.4px',
              lineHeight: 1.2,
              textShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
            }}
          >
            ANPR <span style={{ color: '#f87171' }}>IngentechSystem</span>
          </h1>

          <p style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.85)', marginTop: '4px', fontWeight: 500 }}>
            Reconocimiento de Placas y Control de Acceso
          </p>
        </div>

        {/* Alerta de Error */}
        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              backgroundColor: 'rgba(239, 68, 68, 0.3)',
              border: '1px solid rgba(239, 68, 68, 0.6)',
              padding: '11px 14px',
              borderRadius: '10px',
              color: '#fee2e2',
              fontSize: '12px',
              marginBottom: '18px',
              backdropFilter: 'blur(8px)',
            }}
          >
            <AlertCircle size={18} style={{ flexShrink: 0, color: '#fca5a5' }} />
            <span>{error}</span>
          </div>
        )}

        {/* Formulario Transparentado */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Campo Usuario */}
          <div style={{ position: 'relative' }}>
            <label
              htmlFor="username"
              style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: 700,
                color: 'rgba(255, 255, 255, 0.9)',
                marginBottom: '6px',
                letterSpacing: '0.4px',
              }}
            >
              Usuario Institucional
            </label>
            <div style={{ position: 'relative' }}>
              <span
                style={{
                  position: 'absolute',
                  left: '14px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'rgba(255, 255, 255, 0.7)',
                }}
              >
                <User size={16} />
              </span>
              <input
                id="username"
                type="text"
                placeholder="Ingrese su usuario"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '12px 14px 12px 40px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(255, 255, 255, 0.10)',
                  border: '1px solid rgba(255, 255, 255, 0.24)',
                  color: '#ffffff',
                  fontSize: '13px',
                  outline: 'none',
                  backdropFilter: 'blur(6px)',
                  transition: 'all 0.2s ease',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#f87171';
                  e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.18)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.28)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.24)';
                  e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.10)';
                  e.target.style.boxShadow = 'none';
                }}
              />
            </div>
          </div>

          {/* Campo Contraseña */}
          <div style={{ position: 'relative' }}>
            <label
              htmlFor="password"
              style={{
                display: 'block',
                fontSize: '11px',
                fontWeight: 700,
                color: 'rgba(255, 255, 255, 0.9)',
                marginBottom: '6px',
                letterSpacing: '0.4px',
              }}
            >
              Contraseña
            </label>
            <div style={{ position: 'relative' }}>
              <span
                style={{
                  position: 'absolute',
                  left: '14px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'rgba(255, 255, 255, 0.7)',
                }}
              >
                <Lock size={16} />
              </span>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '12px 40px 12px 40px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(255, 255, 255, 0.10)',
                  border: '1px solid rgba(255, 255, 255, 0.24)',
                  color: '#ffffff',
                  fontSize: '13px',
                  outline: 'none',
                  backdropFilter: 'blur(6px)',
                  transition: 'all 0.2s ease',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#f87171';
                  e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.18)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.28)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.24)';
                  e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.10)';
                  e.target.style.boxShadow = 'none';
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '12px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255, 255, 255, 0.75)',
                  cursor: 'pointer',
                  padding: '4px',
                }}
                title={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Recordarme y Zona */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '2px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', color: 'rgba(255, 255, 255, 0.85)' }}>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                style={{ width: '15px', height: '15px', accentColor: '#ef4444', cursor: 'pointer' }}
              />
              <span>Recordar sesión</span>
            </label>

            <span style={{ fontSize: '11px', color: 'rgba(255, 255, 255, 0.7)' }}>
              Zona 3 Tungurahua
            </span>
          </div>

          {/* Botón de Ingreso Transparentado */}
          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: '10px',
              width: '100%',
              padding: '13px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.95) 0%, rgba(220, 38, 38, 0.95) 100%)',
              color: '#ffffff',
              fontSize: '13px',
              fontWeight: 800,
              letterSpacing: '0.6px',
              border: '1px solid rgba(255, 255, 255, 0.35)',
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 6px 18px rgba(239, 68, 68, 0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'all 0.2s ease',
              backdropFilter: 'blur(6px)',
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow = '0 10px 22px rgba(239, 68, 68, 0.55)';
              }
            }}
            onMouseLeave={(e) => {
              if (!loading) {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 6px 18px rgba(239, 68, 68, 0.45)';
              }
            }}
          >
            <span>{loading ? 'Verificando...' : 'Ingresar al Centro de Control'}</span>
            {!loading && <ArrowRight size={15} />}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
