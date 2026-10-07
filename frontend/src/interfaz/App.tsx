import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, Permiso, useAuth } from '../aplicacion/AuthContext';
import { TiempoRealProvider } from '../aplicacion/tiempoReal';
import { NotificacionesProvider } from './componentes/Notificaciones';
import { CentroNotificacionesProvider } from '../aplicacion/notificaciones';
import { PantallaCarga } from './paginas/auth/componentes';
import { esVistaGestionPermisos } from '../dominio/permisos';

// Cada pantalla se descarga solo cuando se visita: el acceso no carga el panel ni el video,
// y el personal operativo nunca descarga las pantallas de administración.
const AppLayout = lazy(() => import('./plantilla/AppLayout').then(m => ({ default: m.AppLayout })));
const Acceso = lazy(() => import('./paginas/auth/Acceso'));
const ConfiguracionInicial = lazy(() => import('./paginas/auth/ConfiguracionInicial'));
const VerificarEmail = lazy(() => import('./paginas/auth/VerificarEmail'));
const RestablecerPassword = lazy(() => import('./paginas/auth/RestablecerPassword'));
const Inicio = lazy(() => import('./paginas/Inicio'));
const Monitoreo = lazy(() => import('./paginas/Monitoreo'));
const Detecciones = lazy(() => import('./paginas/Detecciones'));
const DetalleDeteccion = lazy(() => import('./paginas/DetalleDeteccion'));
const Listas = lazy(() => import('./paginas/Listas'));
const Reportes = lazy(() => import('./paginas/Reportes'));
const Evaluacion = lazy(() => import('./paginas/Evaluacion'));
const Usuarios = lazy(() => import('./paginas/Usuarios'));
const Auditoria = lazy(() => import('./paginas/Auditoria'));
const Camaras = lazy(() => import('./paginas/Camaras'));
const Configuracion = lazy(() => import('./paginas/Configuracion'));
const Perfil = lazy(() => import('./paginas/Perfil'));
const Notificaciones = lazy(() => import('./paginas/Notificaciones'));
const SolicitudesAcceso = lazy(() => import('./paginas/SolicitudesAcceso'));

/**
 * Exige sesión y, si se indica, el permiso de la pantalla (matriz RBAC del backend, entregada en
 * la sesión). La API vuelve a verificar el permiso en cada endpoint.
 *
 * El gestor de permisos trabaja en una sola vista (la raíz): cualquier otra pantalla con permiso
 * lo devuelve a ella, conservando la consulta (p. ej. ?id= de una solicitud notificada).
 */
const Privada: React.FC<{ permiso?: Permiso; children: React.ReactNode }> = ({ permiso, children }) => {
  const { user, loading, puede } = useAuth();
  const location = useLocation();
  if (loading) return <PantallaCarga texto="VERIFICANDO SESIÓN…" />;
  if (!user) return <Navigate to="/login" replace state={{ desde: location.pathname + location.search }} />;
  if (permiso && esVistaGestionPermisos(puede)) return <Navigate to={{ pathname: '/', search: location.search }} replace />;
  if (permiso && !puede(permiso)) return <Navigate to="/" replace />;
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
              {/* La raíz elige la pantalla de inicio según los permisos (ver Inicio) */}
              <Route path="/" element={<Privada><Inicio /></Privada>} />
              <Route path="/monitoreo" element={<Privada permiso="operacion:monitorear"><Monitoreo /></Privada>} />
              <Route path="/detecciones" element={<Privada permiso="operacion:monitorear"><Detecciones /></Privada>} />
              <Route path="/detecciones/:id" element={<Privada permiso="operacion:monitorear"><DetalleDeteccion /></Privada>} />
              <Route path="/listas/:tipo" element={<Privada permiso="listas:ver"><Listas /></Privada>} />
              <Route path="/solicitudes" element={<Privada permiso="solicitudes:crear"><SolicitudesAcceso /></Privada>} />
              <Route path="/notificaciones" element={<Privada><Notificaciones /></Privada>} />
              <Route path="/perfil" element={<Privada><Perfil /></Privada>} />

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
