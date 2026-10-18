import React from 'react';
import {
  BarChart3, Bell, Camera, ClipboardList, FileCheck2, FlaskConical, History, LayoutDashboard, MonitorPlay, Server, Settings, ShieldAlert,
  ShieldCheck, UserCircle, Users,
} from 'lucide-react';
import { esVistaGestionPermisos, type Permiso } from '../../dominio/permisos';

export interface ItemMenu {
  ruta: string;
  titulo: string;
  descripcion: string;
  icono: React.ReactNode;
  /** Permiso que habilita la entrada (la API aplica el mismo control); sin permiso: basta la sesión */
  permiso?: Permiso;
  /** Clave del contador que se muestra junto al enlace */
  contador?: 'revision' | 'solicitudes';
  oculto?: boolean;
}

export interface GrupoMenu {
  titulo: string;
  items: ItemMenu[];
}

/** Menú por permiso: cada entrada declara el permiso que la habilita (matriz RBAC del backend). */
export const MENU: GrupoMenu[] = [
  {
    titulo: 'Operación',
    items: [
      { ruta: '/', titulo: 'Dashboard', descripcion: 'Resumen de la operación del día', icono: <LayoutDashboard size={18} />, permiso: 'operacion:monitorear' },
      { ruta: '/monitoreo', titulo: 'Monitoreo en vivo', descripcion: 'Video del acceso y detecciones en tiempo real', icono: <MonitorPlay size={18} />, permiso: 'operacion:monitorear' },
      // Registro de canales: solo el administrador (el guardia ve el video, no registra cámaras)
      { ruta: '/camaras', titulo: 'Registro de cámaras', descripcion: 'Alta de canales RTSP, conectividad y diagnóstico', icono: <Camera size={18} />, permiso: 'camaras:gestionar' },
    ],
  },
  {
    titulo: 'Control de accesos',
    items: [
      { ruta: '/listas/autorizados', titulo: 'Lista blanca', descripcion: 'Vehículos autorizados a ingresar, con vigencia y horario', icono: <ShieldCheck size={18} />, permiso: 'listas:ver' },
      { ruta: '/listas/alertas', titulo: 'Lista negra', descripcion: 'Placas con alerta de seguridad: su paso genera una alarma', icono: <ShieldAlert size={18} />, permiso: 'listas:ver' },
      { ruta: '/solicitudes', titulo: 'Solicitudes de acceso', descripcion: 'Autorización de visitas, proveedores y vehículos sin permiso', icono: <FileCheck2 size={18} />, permiso: 'solicitudes:crear', contador: 'solicitudes' },
      { ruta: '/detecciones', titulo: 'Registro de movimientos', descripcion: 'Historial de ingresos y salidas, validación y exportación', icono: <History size={18} />, permiso: 'operacion:monitorear', contador: 'revision' },
    ],
  },
  {
    titulo: 'Análisis',
    items: [
      { ruta: '/reportes', titulo: 'Reportes', descripcion: 'Estadísticas por período, cámara y estado', icono: <BarChart3 size={18} />, permiso: 'reportes:ver' },
      { ruta: '/evaluacion', titulo: 'Evaluación del sistema', descripcion: 'Métricas de exactitud del reconocimiento y de las alarmas', icono: <FlaskConical size={18} />, permiso: 'evaluacion:ver' },
    ],
  },
  {
    titulo: 'Administración',
    items: [
      { ruta: '/usuarios', titulo: 'Usuarios', descripcion: 'Cuentas, roles y accesos del personal', icono: <Users size={18} />, permiso: 'usuarios:gestionar' },
      { ruta: '/sistema', titulo: 'Estado del sistema', descripcion: 'Servicios, cuentas, accesos, listas de control y exactitud de lectura', icono: <Server size={18} />, permiso: 'usuarios:gestionar' },
      { ruta: '/auditoria', titulo: 'Auditoría', descripcion: 'Trazabilidad de acciones y accesos', icono: <ClipboardList size={18} />, permiso: 'auditoria:ver' },
      { ruta: '/configuracion', titulo: 'Configuración', descripcion: 'Parámetros del sistema', icono: <Settings size={18} />, permiso: 'configuracion:gestionar' },
    ],
  },
];

export const RUTAS_EXTRA: ItemMenu[] = [
  { ruta: '/perfil', titulo: 'Mi perfil', descripcion: 'Datos de la cuenta y contraseña', icono: <UserCircle size={18} />, oculto: true },
  { ruta: '/notificaciones', titulo: 'Notificaciones', descripcion: 'Alarmas, avisos y notificaciones del navegador', icono: <Bell size={18} />, oculto: true },
  { ruta: '/detecciones/', titulo: 'Detalle del movimiento', descripcion: 'Evidencia, lectura automática y trazabilidad', icono: <History size={18} />, permiso: 'operacion:monitorear', oculto: true },
];

/**
 * Vista única del gestor de permisos: quien gestiona el padrón sin permisos de operación trabaja
 * en una sola pantalla (solicitudes, permisos de placa y placas sin permiso), sin monitoreo en vivo.
 */
export const MENU_GESTION_PERMISOS: GrupoMenu[] = [
  {
    titulo: 'Control de accesos',
    items: [
      { ruta: '/', titulo: 'Gestión de permisos', descripcion: 'Registre vehículos en la lista blanca y resuelva las solicitudes de acceso', icono: <ShieldCheck size={18} />, permiso: 'padron:gestionar', contador: 'solicitudes' },
    ],
  },
];

export function menuPara(puede: (p: Permiso) => boolean): GrupoMenu[] {
  if (esVistaGestionPermisos(puede)) return MENU_GESTION_PERMISOS;
  return MENU.map(g => ({ ...g, items: g.items.filter(i => !i.permiso || puede(i.permiso)) })).filter(g => g.items.length);
}

/**
 * Barra de pestañas estilo IDE bajo el encabezado (como en vigilance-heart): accesos directos a
 * las vistas de uso diario. Cada pestaña aparece solo si el rol puede abrir esa vista (su entrada
 * del menú, con el mismo permiso que exige la API).
 */
const PESTANAS: { ruta: string; etiqueta: string }[] = [
  { ruta: '/', etiqueta: 'Dashboard' },
  { ruta: '/monitoreo', etiqueta: 'Monitoreo' },
  { ruta: '/detecciones', etiqueta: 'Movimientos' },
  { ruta: '/listas/autorizados', etiqueta: 'Lista blanca' },
  { ruta: '/listas/alertas', etiqueta: 'Lista negra' },
  { ruta: '/solicitudes', etiqueta: 'Solicitudes' },
  { ruta: '/reportes', etiqueta: 'Reportes' },
  { ruta: '/camaras', etiqueta: 'Cámaras' },
  { ruta: '/usuarios', etiqueta: 'Usuarios' },
];

export function pestanasPara(puede: (p: Permiso) => boolean): { ruta: string; etiqueta: string }[] {
  const disponibles = new Set(menuPara(puede).flatMap(g => g.items.map(i => i.ruta)));
  const pestanas = PESTANAS.filter(p => disponibles.has(p.ruta));
  // Con una sola vista (gestor de permisos) la barra no aporta nada
  return pestanas.length > 1 ? pestanas : [];
}

/** Título y descripción de la ruta actual para el encabezado. */
export function itemDeRuta(ruta: string, puede?: (p: Permiso) => boolean): ItemMenu | undefined {
  const menu = puede && esVistaGestionPermisos(puede) ? MENU_GESTION_PERMISOS : MENU;
  const todos = [...menu.flatMap(g => g.items), ...RUTAS_EXTRA];
  return todos.find(i => i.ruta === ruta) ?? todos.filter(i => i.ruta !== '/' && ruta.startsWith(i.ruta)).sort((a, b) => b.ruta.length - a.ruta.length)[0];
}
