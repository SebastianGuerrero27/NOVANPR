import React, { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronsLeft, ChevronsRight, Clock, KeyRound, LogOut, Menu, UserCircle, Volume2, VolumeX } from 'lucide-react';
import api from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento, useTiempoReal } from '../../aplicacion/tiempoReal';
import { useDiferido, useTic } from '../../aplicacion/hooks';
import { iniciales, ROLES } from '../../dominio/formato';
import { Cargando } from '../componentes/ui';
import { AvisosAcceso } from '../componentes/AvisosAcceso';
import { CampanaNotificaciones } from '../componentes/CentroNotificaciones';
import { alCambiarSonido, fijarSonido, sonidoActivo } from '../../infraestructura/avisos';
import { itemDeRuta, menuPara } from './navegacion';
import logo from '../../assets/ecu911.png';

const CLAVE_COLAPSO = 'anpr_menu_colapsado';

/** Pendientes de revisión (contador del menú), actualizado por eventos en tiempo real. */
function useColaRevision(activo: boolean): number {
  const [n, setN] = useState(0);
  const cargar = () => { if (activo) api.get('/detecciones', { params: { estado: 'pendiente_revision', validado: 'no', tamano: 5 } })
    .then(r => setN(r.data.total)).catch(() => undefined); };
  const diferido = useDiferido(cargar, 1500);
  useEffect(() => { cargar(); }, [activo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvento('deteccion:nueva', diferido);
  useEvento('deteccion:actualizada', diferido);
  useEvento('deteccion:eliminada', diferido);
  useEvento('deteccion:eliminadas', diferido);
  return n;
}

/** Solicitudes de acceso pendientes (para quien resuelve: las de otros; para el resto: las propias). */
function useSolicitudesPendientes(activo: boolean): number {
  const [n, setN] = useState(0);
  const cargar = () => { if (activo) api.get('/solicitudes-acceso/resumen').then(r => setN(r.data.pendientes)).catch(() => undefined); };
  const diferido = useDiferido(cargar, 800);
  useEffect(() => { cargar(); }, [activo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvento('solicitudes:actualizadas', diferido);
  return n;
}

const Sidebar: React.FC<{ colapsado: boolean; onColapsar: () => void; abiertoMovil: boolean; onCerrarMovil: () => void }> =
  ({ colapsado, onColapsar, abiertoMovil, onCerrarMovil }) => {
    const { user, puede } = useAuth();
    const revision = useColaRevision(!!user && puede('operacion:monitorear'));
    const solicitudes = useSolicitudesPendientes(!!user && puede('solicitudes:resolver'));
    if (!user) return null;
    const contadores = { revision, solicitudes };
    return (
      <aside className={`sidebar${colapsado ? ' colapsado' : ''}${abiertoMovil ? ' abierto-movil' : ''}`} aria-label="Menú principal">
        <div className="sidebar-marca">
          <div className="logo"><img src={logo} alt="ECU 911" /></div>
          <div className="texto"><strong>Sistema ANPR</strong><span>Control de ingreso vehicular</span></div>
        </div>
        <nav className="sidebar-nav">
          {menuPara(puede).map(g => (
            <div className="sidebar-grupo" key={g.titulo}>
              <div className="sidebar-grupo-titulo">{g.titulo}</div>
              {g.items.map(i => (
                <NavLink key={i.ruta} to={i.ruta} end={i.ruta === '/'} onClick={onCerrarMovil}
                  className={({ isActive }) => `sidebar-link${isActive ? ' activo' : ''}`} title={colapsado ? i.titulo : undefined}>
                  {i.icono}
                  <span className="etiqueta">{i.titulo}</span>
                  {i.contador && contadores[i.contador] > 0 && (
                    <span className="contador" aria-label={`${contadores[i.contador]} pendientes`}>{contadores[i.contador] > 99 ? '99+' : contadores[i.contador]}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-pie">
          <button className="sidebar-colapsar" onClick={onColapsar} aria-label={colapsado ? 'Expandir menú' : 'Contraer menú'}>
            {colapsado ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}<span>Contraer menú</span>
          </button>
        </div>
      </aside>
    );
  };

/** Tiempo restante de sesión; se destaca en los últimos 10 minutos. */
const RelojSesion: React.FC = () => {
  const { expira } = useAuth();
  useTic(30000);
  if (!expira) return null;
  const min = Math.max(0, Math.round((expira - Date.now()) / 60000));
  const texto = min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
  return (
    <span className={`sesion-reloj${min <= 10 ? ' aviso' : ''}`} title="Tiempo restante de la sesión">
      <Clock size={13} /> Sesión: {texto}
    </span>
  );
};

/** Activa o silencia el sonido de los avisos de acceso (preferencia del navegador). */
const BotonSonido: React.FC = () => {
  const [activo, setActivo] = useState(sonidoActivo);
  useEffect(() => alCambiarSonido(setActivo), []);
  return (
    <button className="btn btn-ghost btn-sm btn-icono" onClick={() => fijarSonido(!activo)}
      title={activo ? 'Silenciar el sonido de los avisos' : 'Activar el sonido de los avisos'} aria-label={activo ? 'Silenciar avisos' : 'Activar sonido de avisos'}>
      {activo ? <Volume2 size={17} /> : <VolumeX size={17} color="var(--alerta)" />}
    </button>
  );
};

const MenuUsuario: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', esc); };
  }, [abierto]);
  if (!user) return null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="usuario-boton" onClick={() => setAbierto(a => !a)} aria-expanded={abierto} aria-haspopup="menu">
        <span className="avatar">{iniciales(user.nombre)}</span>
        <span className="usuario-datos ocultar-movil"><strong>{user.nombre}</strong><span>{ROLES[user.rol]}</span></span>
      </button>
      {abierto && (
        <div className="menu" role="menu">
          <div className="menu-cabecera"><strong>{user.nombre}</strong><span>{user.email}</span></div>
          <button className="menu-item" role="menuitem" onClick={() => { setAbierto(false); navigate('/perfil'); }}><UserCircle size={16} /> Mi perfil</button>
          <button className="menu-item" role="menuitem" onClick={() => { setAbierto(false); navigate('/notificaciones'); }}><Bell size={16} /> Notificaciones</button>
          <button className="menu-item" role="menuitem" onClick={() => { setAbierto(false); navigate('/perfil#contrasena'); }}><KeyRound size={16} /> Cambiar contraseña</button>
          <button className="menu-item peligro" role="menuitem" onClick={() => { logout(); navigate('/login', { replace: true }); }}><LogOut size={16} /> Cerrar sesión</button>
        </div>
      )}
    </div>
  );
};

const Header: React.FC<{ onMenuMovil: () => void }> = ({ onMenuMovil }) => {
  const { pathname } = useLocation();
  const { conectado } = useTiempoReal();
  const { puede } = useAuth();
  const item = itemDeRuta(pathname, puede);
  return (
    <header className="header">
      <button className="btn btn-ghost btn-icono header-menu-movil" onClick={onMenuMovil} aria-label="Abrir menú"><Menu size={20} /></button>
      <div className="header-titulo">
        <h1>{item?.titulo ?? 'Sistema ANPR'}</h1>
        {item?.descripcion && <p>{item.descripcion}</p>}
      </div>
      <div className="header-acciones">
        <span className="fila ocultar-movil texto-secundario" style={{ fontSize: 12 }} title={conectado ? 'Recibiendo eventos en tiempo real' : 'Sin conexión de tiempo real: reintentando'}>
          <span className={`punto ${conectado ? 'verde' : 'ambar latido'}`} /> {conectado ? 'En línea' : 'Reconectando…'}
        </span>
        <span className="ocultar-movil"><RelojSesion /></span>
        <BotonSonido />
        <CampanaNotificaciones />
        <MenuUsuario />
      </div>
    </header>
  );
};

export const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [colapsado, setColapsado] = useState(() => {
    try { return localStorage.getItem(CLAVE_COLAPSO) === '1'; } catch { return false; }
  });
  const [movil, setMovil] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => { setMovil(false); }, [pathname]);
  const alternar = () => setColapsado(c => {
    try { localStorage.setItem(CLAVE_COLAPSO, c ? '0' : '1'); } catch { /* sin almacenamiento */ }
    return !c;
  });
  return (
    <div className="app">
      <Sidebar colapsado={colapsado} onColapsar={alternar} abiertoMovil={movil} onCerrarMovil={() => setMovil(false)} />
      {movil && <div className="velo-movil" onClick={() => setMovil(false)} />}
      <div className="contenido">
        <Header onMenuMovil={() => setMovil(true)} />
        <main>
          <Suspense fallback={<Cargando texto="Cargando módulo…" alto={320} />}>{children}</Suspense>
        </main>
        <AvisosAcceso />
      </div>
    </div>
  );
};
