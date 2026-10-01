import React from 'react';
import {
  BarChart3, Bell, Camera, ClipboardList, FileCheck2, FlaskConical, History, LayoutDashboard, MonitorPlay, Settings, ShieldAlert,
  ShieldCheck, UserCircle, Users,
} from 'lucide-react';
import type { Permiso } from '../lib/permisos';

export interface ItemMenu {
  ruta: string;
  titulo: string;
  descripcion: string;
  icono: React.ReactNode;
  /** Permiso que habilita la entrada (la API aplica el mismo control) */
  permiso: Permiso;
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
      { ruta: '/', titulo: 'Inicio', descripcion: 'Resumen de la operación del día', icono: <LayoutDashboard size={18} />, permiso: 'operacion:monitorear' },
      { ruta: '/monitoreo', titulo: 'Monitoreo en vivo', descripcion: 'Video del acceso y detecciones en tiempo real', icono: <MonitorPlay size={18} />, permiso: 'operacion:monitorear' },
      { ruta: '/detecciones', titulo: 'Registro de ingresos', descripcion: 'Historial de pasos vehiculares, validación y exportación', icono: <History size={18} />, permiso: 'operacion:monitorear', contador: 'revision' },
    ],
  },
  {
    titulo: 'Control de accesos',
    items: [
      { ruta: '/listas/autorizados', titulo: 'Permisos de placa', descripcion: 'Padrón de vehículos autorizados con vigencia y horario', icono: <ShieldCheck size={18} />, permiso: 'listas:ver' },
      { ruta: '/solicitudes', titulo: 'Solicitudes de acceso', descripcion: 'Autorización de visitas, proveedores y vehículos sin permiso', icono: <FileCheck2 size={18} />, permiso: 'solicitudes:crear', contador: 'solicitudes' },
      { ruta: '/listas/alertas', titulo: 'Lista de alertas', descripcion: 'Placas con alerta de seguridad', icono: <ShieldAlert size={18} />, permiso: 'listas:ver' },
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
      { ruta: '/auditoria', titulo: 'Auditoría', descripcion: 'Trazabilidad de acciones y accesos', icono: <ClipboardList size={18} />, permiso: 'auditoria:ver' },
      { ruta: '/camaras', titulo: 'Cámaras', descripcion: 'Canales RTSP y conectividad', icono: <Camera size={18} />, permiso: 'camaras:gestionar' },
      { ruta: '/configuracion', titulo: 'Configuración', descripcion: 'Parámetros del sistema', icono: <Settings size={18} />, permiso: 'configuracion:gestionar' },
    ],
  },
];

export const RUTAS_EXTRA: ItemMenu[] = [
  { ruta: '/perfil', titulo: 'Mi perfil', descripcion: 'Datos de la cuenta y contraseña', icono: <UserCircle size={18} />, permiso: 'operacion:monitorear', oculto: true },
  { ruta: '/notificaciones', titulo: 'Notificaciones', descripcion: 'Alarmas, avisos y notificaciones del navegador', icono: <Bell size={18} />, permiso: 'operacion:monitorear', oculto: true },
  { ruta: '/detecciones/', titulo: 'Detalle del ingreso', descripcion: 'Evidencia, lectura automática y trazabilidad', icono: <History size={18} />, permiso: 'operacion:monitorear', oculto: true },
];

export function menuPara(puede: (p: Permiso) => boolean): GrupoMenu[] {
  return MENU.map(g => ({ ...g, items: g.items.filter(i => puede(i.permiso)) })).filter(g => g.items.length);
}

/** Título y descripción de la ruta actual para el encabezado. */
export function itemDeRuta(ruta: string): ItemMenu | undefined {
  const todos = [...MENU.flatMap(g => g.items), ...RUTAS_EXTRA];
  return todos.find(i => i.ruta === ruta) ?? todos.filter(i => i.ruta !== '/' && ruta.startsWith(i.ruta)).sort((a, b) => b.ruta.length - a.ruta.length)[0];
}
