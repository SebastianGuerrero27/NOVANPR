import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, Rol, useAuth } from './context/AuthContext';
import { TiempoRealProvider } from './lib/tiempoReal';
import { NotificacionesProvider } from './components/Notificaciones';
import { PantallaCarga } from './pages/auth/componentes';

// Cada pantalla se descarga solo cuando se visita: el acceso no carga el panel ni el video,
// y el personal operativo nunca descarga las pantallas de administración.
const AppLayout = lazy(() => import('./layout/AppLayout').then(m => ({ default: m.AppLayout })));
const Acceso = lazy(() => import('./pages/auth/Acceso'));
const ConfiguracionInicial = lazy(() => import('./pages/auth/ConfiguracionInicial'));
const VerificarEmail = lazy(() => import('./pages/auth/VerificarEmail'));
const RestablecerPassword = lazy(() => import('./pages/auth/RestablecerPassword'));
const Inicio = lazy(() => import('./pages/Inicio'));
const Monitoreo = lazy(() => import('./pages/Monitoreo'));
const Detecciones = lazy(() => import('./pages/Detecciones'));
const DetalleDeteccion = lazy(() => import('./pages/DetalleDeteccion'));
const Listas = lazy(() => import('./pages/Listas'));
const Reportes = lazy(() => import('./pages/Reportes'));
const Evaluacion = lazy(() => import('./pages/Evaluacion'));
const Usuarios = lazy(() => import('./pages/Usuarios'));
const Auditoria = lazy(() => import('./pages/Auditoria'));
const Camaras = lazy(() => import('./pages/Camaras'));
const Configuracion = lazy(() => import('./pages/Configuracion'));
const Perfil = lazy(() => import('./pages/Perfil'));

const TODOS: Rol[] = ['Admin', 'Supervisor', 'Operador'];
const GESTION: Rol[] = ['Admin', 'Supervisor'];
const ADMIN: Rol[] = ['Admin'];

/** Exige sesión y rol; la API aplica el mismo control en cada endpoint. */
const Privada: React.FC<{ roles: Rol[]; children: React.ReactNode }> = ({ roles, children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PantallaCarga texto="VERIFICANDO SESIÓN…" />;
  if (!user) return <Navigate to="/login" replace state={{ desde: location.pathname + location.search }} />;
  if (!roles.includes(user.rol)) return <Navigate to="/" replace />;
  return <AppLayout>{children}</AppLayout>;
};

const App: React.FC = () => (
  <Router>
    <AuthProvider>
      <TiempoRealProvider>
        <NotificacionesProvider>
          <Suspense fallback={<PantallaCarga />}>
            <Routes>
              {/* Acceso y ciclo de vida de la cuenta */}
              <Route path="/login" element={<Acceso />} />
              <Route path="/registro" element={<Acceso />} />
              <Route path="/configuracion-inicial" element={<ConfiguracionInicial />} />
              <Route path="/verificar-email" element={<VerificarEmail />} />
              <Route path="/restablecer-password" element={<RestablecerPassword />} />

              {/* Operación */}
              <Route path="/" element={<Privada roles={TODOS}><Inicio /></Privada>} />
              <Route path="/monitoreo" element={<Privada roles={TODOS}><Monitoreo /></Privada>} />
              <Route path="/detecciones" element={<Privada roles={TODOS}><Detecciones /></Privada>} />
              <Route path="/detecciones/:id" element={<Privada roles={TODOS}><DetalleDeteccion /></Privada>} />
              <Route path="/listas/:tipo" element={<Privada roles={TODOS}><Listas /></Privada>} />
              <Route path="/perfil" element={<Privada roles={TODOS}><Perfil /></Privada>} />

              {/* Análisis */}
              <Route path="/reportes" element={<Privada roles={GESTION}><Reportes /></Privada>} />
              <Route path="/evaluacion" element={<Privada roles={GESTION}><Evaluacion /></Privada>} />

              {/* Administración */}
              <Route path="/usuarios" element={<Privada roles={ADMIN}><Usuarios /></Privada>} />
              <Route path="/auditoria" element={<Privada roles={ADMIN}><Auditoria /></Privada>} />
              <Route path="/camaras" element={<Privada roles={ADMIN}><Camaras /></Privada>} />
              <Route path="/configuracion" element={<Privada roles={ADMIN}><Configuracion /></Privada>} />

              {/* Rutas anteriores */}
              <Route path="/historial" element={<Navigate to="/detecciones" replace />} />
              <Route path="/canales" element={<Navigate to="/camaras" replace />} />
              <Route path="/listas" element={<Navigate to="/listas/autorizados" replace />} />
              <Route path="/admin" element={<Navigate to="/usuarios" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </NotificacionesProvider>
      </TiempoRealProvider>
    </AuthProvider>
  </Router>
);

export default App;
