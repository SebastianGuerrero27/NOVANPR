import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, Permiso, useAuth } from './context/AuthContext';
import { TiempoRealProvider } from './lib/tiempoReal';
import { NotificacionesProvider } from './components/Notificaciones';
import { CentroNotificacionesProvider } from './lib/notificaciones';
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
const Notificaciones = lazy(() => import('./pages/Notificaciones'));
const SolicitudesAcceso = lazy(() => import('./pages/SolicitudesAcceso'));

/**
 * Exige sesión y el permiso de la pantalla (matriz RBAC del backend, entregada en la sesión).
 * La API vuelve a verificar el permiso en cada endpoint.
 */
const Privada: React.FC<{ permiso: Permiso; children: React.ReactNode }> = ({ permiso, children }) => {
  const { user, loading, puede } = useAuth();
  const location = useLocation();
  if (loading) return <PantallaCarga texto="VERIFICANDO SESIÓN…" />;
  if (!user) return <Navigate to="/login" replace state={{ desde: location.pathname + location.search }} />;
  if (!puede(permiso)) {
    // En la ruta raíz no se redirige (evita un ciclo si la sesión no trae permisos)
    if (location.pathname === '/') {
      return <AppLayout><div className="pagina"><div className="tarjeta" style={{ padding: 24 }}>Su cuenta no tiene permisos asignados. Contacte al administrador.</div></div></AppLayout>;
    }
    return <Navigate to="/" replace />;
  }
  return <AppLayout>{children}</AppLayout>;
};

const App: React.FC = () => (
  <Router>
    <AuthProvider>
      <TiempoRealProvider>
        <NotificacionesProvider>
          <CentroNotificacionesProvider>
          <Suspense fallback={<PantallaCarga />}>
            <Routes>
              {/* Acceso y ciclo de vida de la cuenta */}
              <Route path="/login" element={<Acceso />} />
              <Route path="/registro" element={<Acceso />} />
              <Route path="/configuracion-inicial" element={<ConfiguracionInicial />} />
              <Route path="/verificar-email" element={<VerificarEmail />} />
              <Route path="/restablecer-password" element={<RestablecerPassword />} />

              {/* Operación */}
              <Route path="/" element={<Privada permiso="operacion:monitorear"><Inicio /></Privada>} />
              <Route path="/monitoreo" element={<Privada permiso="operacion:monitorear"><Monitoreo /></Privada>} />
              <Route path="/detecciones" element={<Privada permiso="operacion:monitorear"><Detecciones /></Privada>} />
              <Route path="/detecciones/:id" element={<Privada permiso="operacion:monitorear"><DetalleDeteccion /></Privada>} />
              <Route path="/listas/:tipo" element={<Privada permiso="listas:ver"><Listas /></Privada>} />
              <Route path="/solicitudes" element={<Privada permiso="solicitudes:crear"><SolicitudesAcceso /></Privada>} />
              <Route path="/notificaciones" element={<Privada permiso="operacion:monitorear"><Notificaciones /></Privada>} />
              <Route path="/perfil" element={<Privada permiso="operacion:monitorear"><Perfil /></Privada>} />

              {/* Análisis */}
              <Route path="/reportes" element={<Privada permiso="reportes:ver"><Reportes /></Privada>} />
              <Route path="/evaluacion" element={<Privada permiso="evaluacion:ver"><Evaluacion /></Privada>} />

              {/* Administración */}
              <Route path="/usuarios" element={<Privada permiso="usuarios:gestionar"><Usuarios /></Privada>} />
              <Route path="/auditoria" element={<Privada permiso="auditoria:ver"><Auditoria /></Privada>} />
              <Route path="/camaras" element={<Privada permiso="camaras:gestionar"><Camaras /></Privada>} />
              <Route path="/configuracion" element={<Privada permiso="configuracion:gestionar"><Configuracion /></Privada>} />

              {/* Rutas anteriores */}
              <Route path="/historial" element={<Navigate to="/detecciones" replace />} />
              <Route path="/canales" element={<Navigate to="/camaras" replace />} />
              <Route path="/listas" element={<Navigate to="/listas/autorizados" replace />} />
              <Route path="/admin" element={<Navigate to="/usuarios" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          </CentroNotificacionesProvider>
        </NotificacionesProvider>
      </TiempoRealProvider>
    </AuthProvider>
  </Router>
);

export default App;
