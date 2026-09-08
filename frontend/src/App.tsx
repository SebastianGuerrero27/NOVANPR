import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import AppSidebar from './components/AppSidebar';
import TopHeader from './components/TopHeader';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Historial from './pages/Historial';
import AdminPanel from './pages/AdminPanel';
import RegistroCanal from './pages/RegistroCanal';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'Admin' | 'Operador';
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requiredRole }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          backgroundColor: '#0b1329',
          color: 'white',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div
          style={{
            width: '38px',
            height: '38px',
            border: '3px solid rgba(239, 68, 68, 0.2)',
            borderTop: '3px solid #ef4444',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <h3 style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.5px' }}>
          VERIFICANDO CREDENCIALES ECU 911...
        </h3>
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole && user.rol !== requiredRole) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#f8fafc', color: '#0f172a' }}>
      {/* Sidebar Colapsable a la Izquierda */}
      <AppSidebar collapsed={collapsed} setCollapsed={setCollapsed} />

      {/* Contenedor Principal Derecho (Header + Contenido) */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflowX: 'hidden' }}>
        <TopHeader />
        <main style={{ flex: 1, overflowY: 'auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <AuthProvider>
        <Routes>
          {/* Ruta de Login limpia (sin sidebar) */}
          <Route path="/login" element={<Login />} />

          {/* Rutas Protegidas dentro del MainLayout con AppSidebar */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <Dashboard />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/canales"
            element={
              <ProtectedRoute requiredRole="Admin">
                <MainLayout>
                  <RegistroCanal />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/historial"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <Historial />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/admin"
            element={
              <ProtectedRoute requiredRole="Admin">
                <MainLayout>
                  <AdminPanel />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          {/* Redirección por defecto */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </Router>
  );
};

export default App;
