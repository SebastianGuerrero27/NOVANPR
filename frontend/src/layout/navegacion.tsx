import React from 'react';
import {
  BarChart3, Camera, ClipboardList, FlaskConical, History, LayoutDashboard, MonitorPlay, Settings, ShieldAlert,
  ShieldCheck, UserCircle, Users,
} from 'lucide-react';
import type { Rol } from '../context/AuthContext';

export interface ItemMenu {
  ruta: string;
  titulo: string;
  descripcion: string;
  icono: React.ReactNode;
  roles?: Rol[];
  /** Clave del contador que se muestra junto al enlace */
  contador?: 'revision';
  oculto?: boolean;
}

export interface GrupoMenu {
  titulo: string;
  items: ItemMenu[];
}

const TODOS: Rol[] = ['Admin', 'Supervisor', 'Operador'];
const GESTION: Rol[] = ['Admin', 'Supervisor'];
const ADMIN: Rol[] = ['Admin'];

/** Menú por rol: cada ruta declara qué roles la ven (la API aplica el mismo control). */
export const MENU: GrupoMenu[] = [
  {
    titulo: 'Operación',
    items: [
      { ruta: '/', titulo: 'Inicio', descripcion: 'Resumen de la operación del día', icono: <LayoutDashboard size={18} />, roles: TODOS },
      { ruta: '/monitoreo', titulo: 'Monitoreo en vivo', descripcion: 'Video del acceso y detecciones en tiempo real', icono: <MonitorPlay size={18} />, roles: TODOS },
      { ruta: '/detecciones', titulo: 'Registro de ingresos', descripcion: 'Historial de pasos vehiculares, validación y exportación', icono: <History size={18} />, roles: TODOS, contador: 'revision' },
    ],
  },
  {
    titulo: 'Listas de control',
    items: [
      { ruta: '/listas/autorizados', titulo: 'Vehículos autorizados', descripcion: 'Padrón institucional con vigencias', icono: <ShieldCheck size={18} />, roles: TODOS },
      { ruta: '/listas/alertas', titulo: 'Lista de alertas', descripcion: 'Placas con alerta de seguridad', icono: <ShieldAlert size={18} />, roles: TODOS },
    ],
  },
  {
    titulo: 'Análisis',
    items: [
      { ruta: '/reportes', titulo: 'Reportes', descripcion: 'Estadísticas por período, cámara y estado', icono: <BarChart3 size={18} />, roles: GESTION },
      { ruta: '/evaluacion', titulo: 'Evaluación del sistema', descripcion: 'Métricas de exactitud del reconocimiento', icono: <FlaskConical size={18} />, roles: GESTION },
    ],
  },
  {
    titulo: 'Administración',
    items: [
      { ruta: '/usuarios', titulo: 'Usuarios', descripcion: 'Cuentas, roles y accesos del personal', icono: <Users size={18} />, roles: ADMIN },
      { ruta: '/auditoria', titulo: 'Auditoría', descripcion: 'Trazabilidad de acciones y accesos', icono: <ClipboardList size={18} />, roles: ADMIN },
      { ruta: '/camaras', titulo: 'Cámaras', descripcion: 'Canales RTSP y conectividad', icono: <Camera size={18} />, roles: ADMIN },
      { ruta: '/configuracion', titulo: 'Configuración', descripcion: 'Parámetros del sistema', icono: <Settings size={18} />, roles: ADMIN },
    ],
  },
];

export const RUTAS_EXTRA: ItemMenu[] = [
  { ruta: '/perfil', titulo: 'Mi perfil', descripcion: 'Datos de la cuenta y contraseña', icono: <UserCircle size={18} />, roles: TODOS, oculto: true },
  { ruta: '/detecciones/', titulo: 'Detalle del ingreso', descripcion: 'Evidencia, lectura automática y trazabilidad', icono: <History size={18} />, roles: TODOS, oculto: true },
];

export function menuPara(rol: Rol): GrupoMenu[] {
  return MENU.map(g => ({ ...g, items: g.items.filter(i => !i.roles || i.roles.includes(rol)) })).filter(g => g.items.length);
}

/** Título y descripción de la ruta actual para el encabezado. */
export function itemDeRuta(ruta: string): ItemMenu | undefined {
  const todos = [...MENU.flatMap(g => g.items), ...RUTAS_EXTRA];
  return todos.find(i => i.ruta === ruta) ?? todos.filter(i => i.ruta !== '/' && ruta.startsWith(i.ruta)).sort((a, b) => b.ruta.length - a.ruta.length)[0];
}
