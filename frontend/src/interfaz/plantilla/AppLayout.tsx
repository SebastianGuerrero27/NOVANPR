import React, { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, Camera, ChevronDown, ChevronsLeft, ChevronsRight, Clock, GripVertical, KeyRound, LogOut, Menu, Moon, Shield, Sun, UserCircle, Volume2, VolumeX, Wifi, WifiOff,
} from 'lucide-react';
import api from '../../infraestructura/api';
import type { Camara } from '../../dominio/tipos';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento, useReconexion, useTiempoReal } from '../../aplicacion/tiempoReal';
import { useDiferido, useTic } from '../../aplicacion/hooks';
import { iniciales, ROLES } from '../../dominio/formato';
import { Cargando } from '../componentes/ui';
import { AvisosAcceso } from '../componentes/AvisosAcceso';
import { CampanaNotificaciones } from '../componentes/CentroNotificaciones';
import { alCambiarSonido, fijarSonido, sonidoActivo } from '../../infraestructura/avisos';
import { itemDeRuta, menuPara, pestanasPara } from './navegacion';
import logo from '../../assets/ecu911.png';

const CLAVE_COLAPSO = 'anpr_menu_colapsado';
const CLAVE_TEMA = 'anpr_tema';

const BotonTema: React.FC = () => {
  const [oscuro, setOscuro] = useState(() => {
    try { return localStorage.getItem(CLAVE_TEMA) === 'oscuro'; } catch { return false; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = oscuro ? 'dark' : 'light';
    try { localStorage.setItem(CLAVE_TEMA, oscuro ? 'oscuro' : 'claro'); } catch { /* preferencia no disponible */ }
  }, [oscuro]);
  return (
    <button className="btn btn-ghost btn-sm btn-icono" onClick={() => setOscuro(v => !v)}
      title={oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'} aria-label={oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}>
      {oscuro ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
};

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
  useReconexion(diferido);
  return n;
}

/** Solicitudes de acceso pendientes (para quien resuelve: las de otros; para el resto: las propias). */
function useSolicitudesPendientes(activo: boolean): number {
  const [n, setN] = useState(0);
  const cargar = () => { if (activo) api.get('/solicitudes-acceso/resumen').then(r => setN(r.data.pendientes)).catch(() => undefined); };
  const diferido = useDiferido(cargar, 800);
  useEffect(() => { cargar(); }, [activo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvento('solicitudes:actualizadas', diferido);
  useReconexion(diferido);
  return n;
}

const Sidebar: React.FC<{ colapsado: boolean; onColapsar: () => void; abiertoMovil: boolean; onCerrarMovil: () => void }> =
  ({ colapsado, onColapsar, abiertoMovil, onCerrarMovil }) => {
    const { user, puede } = useAuth();
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const [camaras, setCamaras] = useState<Camara[]>([]);
    useEffect(() => {
      if (!user || !puede('operacion:monitorear')) return;
      let vigente = true;
      api.get('/camaras').then(r => { if (vigente) setCamaras(r.data); }).catch(() => undefined);
      return () => { vigente = false; };
    }, [user, puede, pathname]);
    useEvento<Camara>('camara:actualizada', c => setCamaras(actual => actual.some(x => x.id === c.id)
      ? actual.map(x => x.id === c.id ? { ...x, ...c } : x)
      : [...actual, c]));
    useEvento<{ id: number }>('camara:eliminada', ({ id }) => setCamaras(actual => actual.filter(c => c.id !== id)));
    const revision = useColaRevision(!!user && puede('operacion:monitorear'));
    const solicitudes = useSolicitudesPendientes(!!user && puede('solicitudes:resolver'));
    if (!user) return null;
    const contadores = { revision, solicitudes };
    return (
      <aside className={`sidebar${colapsado ? ' colapsado' : ''}${abiertoMovil ? ' abierto-movil' : ''}`} aria-label="Menú principal">
        <div className="sidebar-marca">
          <div className="logo"><img src={logo} alt="ECU 911" /></div>
          <div className="texto"><strong>ECU 911</strong><span>Sistema ANPR</span></div>
        </div>
        <nav className="sidebar-nav">
          {menuPara(puede).map(g => (
            <div className="sidebar-grupo" key={g.titulo}>
              <div className="sidebar-grupo-titulo">{g.titulo}</div>
              {g.items.map(i => (
                <React.Fragment key={i.ruta}>
                  <NavLink to={i.ruta} end={i.ruta === '/'} onClick={onCerrarMovil}
                    className={({ isActive }) => `sidebar-link${isActive ? ' activo' : ''}`} title={colapsado ? i.titulo : undefined}>
                    {i.icono}
                    <span className="etiqueta">{i.titulo}</span>
                    {i.contador && contadores[i.contador] > 0 && (
                      <span className="contador" aria-label={`${contadores[i.contador]} pendientes`}>{contadores[i.contador] > 99 ? '99+' : contadores[i.contador]}</span>
                    )}
                  </NavLink>
                  {i.ruta === '/camaras' && puede('operacion:monitorear') && (
                    <div className="sidebar-submenu-camaras">
                      <div className="sidebar-submenu-titulo">Cámaras registradas</div>
                      {camaras.map(c => (
                        <button key={c.id} type="button" className={`sidebar-link sidebar-camara${c.activa ? '' : ' deshabilitada'}`}
                          draggable={c.activa}
                          onDragStart={e => { e.dataTransfer.setData('application/x-anpr-camera', String(c.id)); e.dataTransfer.effectAllowed = 'copy'; }}
                          onClick={() => { if (window.location.pathname !== '/monitoreo') navigate('/monitoreo'); }}
                          title={colapsado ? `${c.nombre} · ${c.direccion}` : `Arrastre ${c.nombre} a una celda de Vista cuadrícula · ${c.direccion}`}>
                          <GripVertical size={14} className="sidebar-camara-arrastre" />
                          <Camera size={16} />
                          <span className="etiqueta">{c.nombre}<small>{c.direccion === 'salida' ? 'Salida' : 'Ingreso'}{c.activa ? '' : ' · Deshabilitada'}</small></span>
                        </button>
                      ))}
                      {camaras.length === 0 && !colapsado && <span className="sidebar-camaras-vacio">Sin cámaras registradas</span>}
                    </div>
                  )}
                </React.Fragment>
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
      <button className={`boton-rol${user.rol === 'Admin' ? ' admin' : ''}`} onClick={() => setAbierto(a => !a)} aria-expanded={abierto} aria-haspopup="menu"
        title="Perfil, notificaciones y sesión">
        <Shield size={13} /><span className="ocultar-movil">{ROLES[user.rol]}</span><ChevronDown size={13} style={{ opacity: 0.7 }} />
      </button>
      {abierto && (
        <div className="menu" role="menu">
          <div className="menu-cabecera fila" style={{ flexWrap: 'nowrap', gap: 10 }}>
            <span className="avatar">{iniciales(user.nombre)}</span>
            <div style={{ minWidth: 0 }}><strong>{user.nombre}</strong><span>{user.email}</span></div>
          </div>
          <button className="menu-item" role="menuitem" onClick={() => { setAbierto(false); navigate('/perfil'); }}><UserCircle size={16} /> Mi perfil</button>
          <button className="menu-item" role="menuitem" onClick={() => { setAbierto(false); navigate('/notificaciones'); }}><Bell size={16} /> Notificaciones</button>
          <button className="menu-item" role="menuitem" onClick={() => { setAbierto(false); navigate('/perfil#contrasena'); }}><KeyRound size={16} /> Cambiar contraseña</button>
          <button className="menu-item peligro" role="menuitem" onClick={() => { logout(); navigate('/login', { replace: true }); }}><LogOut size={16} /> Cerrar sesión</button>
        </div>
      )}
    </div>
  );
};

/** Barra de pestañas estilo IDE: accesos directos a las vistas de uso diario del rol. */
const BarraPestanas: React.FC = () => {
  const { puede } = useAuth();
  const pestanas = pestanasPara(puede);
  if (!pestanas.length) return null;
  return (
    <nav className="ide-tab-bar" aria-label="Accesos rápidos">
      {pestanas.map(p => (
        <NavLink key={p.ruta} to={p.ruta} end={p.ruta === '/'} className={({ isActive }) => `ide-tab${isActive ? ' activa' : ''}`}>{p.etiqueta}</NavLink>
      ))}
    </nav>
  );
};

const Header: React.FC<{ onMenuMovil: () => void }> = ({ onMenuMovil }) => {
  const { pathname } = useLocation();
  const { conectado } = useTiempoReal();
  const { puede, user } = useAuth();
  const item = itemDeRuta(pathname, puede);
  return (
    <header className="header">
      <div className="header-fila">
        <button className="btn btn-ghost btn-icono header-menu-movil" onClick={onMenuMovil} aria-label="Abrir menú"><Menu size={20} /></button>
        <div className="header-titulo" title={item?.descripcion}>
          <span className="header-sistema">Sistema ANPR</span>
          <h1>{item?.titulo ?? 'Inicio'}</h1>
        </div>
        <div className="header-acciones">
          <span className={`pastilla-red ocultar-movil ${conectado ? 'en-linea' : 'sin-conexion'}`}
            title={conectado ? 'Recibiendo eventos en tiempo real' : 'Sin conexión de tiempo real: reintentando'}>
            {conectado ? <Wifi size={13} /> : <WifiOff size={13} />} {conectado ? 'En línea' : 'Reconectando…'}
          </span>
          <span className="ocultar-movil"><RelojSesion /></span>
          <BotonTema />
          <BotonSonido />
          <CampanaNotificaciones />
          {user && <span className="pastilla-usuario ocultar-movil" title={user.nombre}><span className="punto-vivo" />{user.nombre}</span>}
          <MenuUsuario />
        </div>
      </div>
      <BarraPestanas />
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
