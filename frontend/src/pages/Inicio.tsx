import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, CalendarClock, Camera, CarFront, CheckCircle2, ClipboardPlus, Clock, Database,
  KeyRound, Mail, MonitorPlay, Server, ShieldAlert, ShieldCheck, Target, TrendingDown, TrendingUp, UserCheck,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta, useDiferido, usePaginaVisible } from '../lib/hooks';
import type { Deteccion, PanelAdministracion, ResumenPanel } from '../lib/tipos';
import { diaCorto, fechaHora, numero, relativo, ROLES, SERIES_ESTADO } from '../lib/formato';
import { Aviso, Cargando, Kpi, Tarjeta, Vacio } from '../components/ui';
import { BarraDistribucion, BarrasApiladas, Leyenda } from '../components/Graficos';
import { RegistroManualModal, TarjetaDeteccion, ValidarModal } from '../components/deteccion';

function saludo(): string {
  const h = Number(new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
}

/** Recarga el resumen cuando llegan eventos (agrupados cada 5 s) y al volver a la pestaña. */
function useResumen() {
  const consulta = useConsulta<ResumenPanel>(() => api.get('/panel/resumen').then(r => r.data), []);
  const visible = usePaginaVisible();
  const [pendiente, setPendiente] = useState(false);
  const recargar = useDiferido(() => {
    if (document.visibilityState === 'visible') consulta.recargar(true);
    else setPendiente(true);
  }, 5000);
  useEffect(() => { if (visible && pendiente) { setPendiente(false); consulta.recargar(true); } }, [visible, pendiente]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvento('deteccion:nueva', recargar);
  useEvento('deteccion:actualizada', recargar);
  useEvento('deteccion:eliminada', recargar);
  useEvento('deteccion:eliminadas', recargar);
  useEvento('camara:estado', recargar);
  useEvento('camara:actualizada', recargar);
  useEvento('listas:actualizadas', recargar);
  return consulta;
}

const Variacion: React.FC<{ hoy: number; ayer: number }> = ({ hoy, ayer }) => {
  if (!ayer) return <span>{hoy ? 'Sin registros ayer a esta hora' : 'Sin actividad todavía'}</span>;
  const d = Math.round(((hoy - ayer) / ayer) * 100);
  return d === 0 ? <span>Igual que ayer a esta hora</span> : (
    <span className={d > 0 ? 'sube' : 'baja'} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {d > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{Math.abs(d)} % vs. ayer a esta hora
    </span>
  );
};

/* ─────────────── Panel operativo (todos los roles) ─────────────── */

const KpisDelDia: React.FC<{ r: ResumenPanel | null; cargando: boolean }> = ({ r, cargando }) => {
  const navigate = useNavigate();
  const hoy = r?.hoy;
  return (
    <div className="grid-kpi">
      <Kpi etiqueta="Ingresos hoy" valor={numero(hoy?.total)} icono={<CarFront size={17} />} cargando={cargando}
        pie={r && <Variacion hoy={r.hoy.total} ayer={r.ayer_misma_hora} />} onClick={() => navigate('/detecciones')} />
      <Kpi etiqueta="Autorizados" valor={numero(hoy?.autorizados)} icono={<ShieldCheck size={17} />} color="var(--autorizado)" fondo="var(--autorizado-bg)" cargando={cargando}
        pie={hoy && hoy.total > 0 ? `${Math.round((hoy.autorizados / hoy.total) * 100)} % del total` : 'Padrón institucional'}
        onClick={() => navigate('/detecciones?estado=autorizado')} />
      <Kpi etiqueta="Por validar" valor={numero(r?.cola_revision)} icono={<Clock size={17} />} color="var(--pendiente)" fondo="var(--pendiente-bg)" cargando={cargando}
        pie="Lecturas dudosas o sin lectura" onClick={() => navigate('/detecciones?estado=pendiente_revision&validado=no')} />
      <Kpi etiqueta="No registrados" valor={numero(hoy?.no_registrados)} icono={<AlertTriangle size={17} />} color="var(--no-registrado)" fondo="var(--no-registrado-bg)" cargando={cargando}
        pie="Fuera del padrón y sin alerta" onClick={() => navigate('/detecciones?estado=no_reconocido')} />
      <Kpi etiqueta="Alertas hoy" valor={numero(hoy?.alertas)} icono={<ShieldAlert size={17} />} color="var(--alerta)" fondo="var(--alerta-bg)" cargando={cargando}
        pie={`${numero(r?.listas.alertas_vigentes)} placas en la lista`} onClick={() => navigate('/detecciones?estado=alerta')} />
    </div>
  );
};

const GraficoPorHora: React.FC<{ r: ResumenPanel }> = ({ r }) => {
  const horaActual = Number(new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', hour: 'numeric', hour12: false }).format(new Date()));
  return (
    <Tarjeta titulo="Ingresos por hora" subtitulo="Hoy, por estado de la decisión" acciones={<Leyenda series={SERIES_ESTADO} />}>
      {r.hoy.total === 0
        ? <Vacio titulo="Sin ingresos hoy" texto="El gráfico se completa a medida que el sistema registra pasos vehiculares." icono={<Activity size={22} />} />
        : <BarrasApiladas datos={r.por_hora} series={SERIES_ESTADO} etiquetaX={d => String(d.hora).padStart(2, '0')}
            tituloTip={d => `${String(d.hora).padStart(2, '0')}:00 – ${String(d.hora).padStart(2, '0')}:59`} cadaEtiqueta={2} resaltar={horaActual} />}
    </Tarjeta>
  );
};

const EstadoCamaras: React.FC<{ r: ResumenPanel }> = ({ r }) => (
  <Tarjeta titulo="Cámaras" subtitulo="Conectividad del puerto RTSP" sinPadding>
    {r.camaras.length === 0 ? <Vacio titulo="No hay cámaras registradas" texto="El administrador registra los canales en Administración › Cámaras." icono={<Camera size={22} />} /> : (
      <div className="tabla-contenedor"><table className="tabla"><tbody>
        {r.camaras.map(c => {
          const e = !c.activa ? { p: 'gris', t: 'Deshabilitada' } : c.estado === 'EN_LINEA' ? { p: 'verde', t: 'En línea' } : c.estado === 'SIN_CONEXION' ? { p: 'rojo', t: 'Sin conexión' } : { p: 'gris', t: 'Sin verificar' };
          return (
            <tr key={c.id}>
              <td><strong style={{ color: 'var(--text)' }}>{c.nombre}</strong><span className="secundario">{c.ubicacion}</span></td>
              <td><span className="fila" style={{ gap: 6 }}><span className={`punto ${e.p}`} />{e.t}</span>
                <span className="secundario">{c.ultimo_ping ? `Verificada ${relativo(c.ultimo_ping)}` : 'Nunca verificada'}</span></td>
              <td className="num"><strong style={{ color: 'var(--text)' }}>{numero(c.detecciones_hoy)}</strong><span className="secundario">hoy</span></td>
            </tr>
          );
        })}
      </tbody></table></div>
    )}
  </Tarjeta>
);

const UltimasAlertas: React.FC<{ r: ResumenPanel }> = ({ r }) => (
  <Tarjeta titulo="Últimas alertas" acciones={<Link to="/detecciones?estado=alerta" className="btn btn-ghost btn-sm">Ver todas <ArrowRight size={14} /></Link>} sinPadding>
    {r.ultimas_alertas.length === 0 ? <Vacio titulo="Sin alertas registradas" icono={<ShieldCheck size={22} />} /> : (
      <div className="pila" style={{ gap: 8, padding: 12 }}>{r.ultimas_alertas.map(d => <TarjetaDeteccion key={d.id} d={d} />)}</div>
    )}
  </Tarjeta>
);

/** Panel del operador: su turno, la cola de validación y accesos directos. */
const PanelOperador: React.FC = () => {
  const { user } = useAuth();
  const { datos: r, cargando, error } = useResumen();
  const cola = useConsulta<{ items: Deteccion[]; total: number }>(
    () => api.get('/detecciones', { params: { estado: 'pendiente_revision', validado: 'no', tamano: 6 } }).then(x => x.data), []);
  const recargarCola = useDiferido(() => cola.recargar(true), 1500);
  useEvento('deteccion:actualizada', recargarCola);
  useEvento('deteccion:nueva', recargarCola);
  const [validando, setValidando] = useState<Deteccion | null>(null);
  const [manual, setManual] = useState(false);

  return (
    <div className="pagina">
      <div className="fila" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 21, fontWeight: 800 }}>{saludo()}, {user?.nombre.split(' ')[0]}</h2>
          <p className="texto-secundario">Resumen del acceso vehicular de hoy · {fechaHora(new Date())}</p>
        </div>
        <div className="fila">
          <button className="btn btn-secondary" onClick={() => setManual(true)}><ClipboardPlus size={16} /> Ingreso manual</button>
          <Link to="/monitoreo" className="btn btn-primary"><MonitorPlay size={16} /> Abrir monitoreo</Link>
        </div>
      </div>
      {error && <Aviso tipo="error" style={{ marginBottom: 16 }}>{error}</Aviso>}
      <div className="pila">
        <KpisDelDia r={r} cargando={cargando} />
        <div className="grid-principal">
          <Tarjeta titulo="Pendientes de validación" subtitulo="Pasos sin lectura confiable: confirme la placa con la evidencia"
            acciones={<Link to="/detecciones?estado=pendiente_revision&validado=no" className="btn btn-ghost btn-sm">Ver todos ({numero(cola.datos?.total)}) <ArrowRight size={14} /></Link>} sinPadding>
            {cola.cargando ? <Cargando /> : !cola.datos?.items.length
              ? <Vacio titulo="Nada pendiente" texto="Todas las lecturas están confirmadas." icono={<CheckCircle2 size={22} />} />
              : <div className="grid-2" style={{ padding: 12, gap: 8 }}>{cola.datos.items.map(d => <TarjetaDeteccion key={d.id} d={d} onValidar={setValidando} />)}</div>}
          </Tarjeta>
          {r ? <UltimasAlertas r={r} /> : <Tarjeta titulo="Últimas alertas"><Cargando /></Tarjeta>}
        </div>
        {r && <div className="grid-principal"><GraficoPorHora r={r} /><EstadoCamaras r={r} /></div>}
      </div>
      {validando && <ValidarModal d={validando} onCerrar={() => setValidando(null)} onValidada={() => cola.recargar(true)} />}
      {manual && <RegistroManualModal onCerrar={() => setManual(false)} />}
    </div>
  );
};

/* ─────────────── Panel de gestión (Administrador y Supervisor) ─────────────── */

const Tendencia: React.FC<{ r: ResumenPanel }> = ({ r }) => (
  <Tarjeta titulo="Últimos 7 días" subtitulo="Ingresos diarios por estado" acciones={<Leyenda series={SERIES_ESTADO} />}>
    {r.tendencia.every(d => d.total === 0)
      ? <Vacio titulo="Sin ingresos en los últimos 7 días" icono={<Activity size={22} />} />
      : <BarrasApiladas datos={r.tendencia} series={SERIES_ESTADO} etiquetaX={d => diaCorto(d.fecha)} alto={200} resaltar={6} />}
  </Tarjeta>
);

const Listas: React.FC<{ r: ResumenPanel }> = ({ r }) => {
  const l = r.listas;
  return (
    <Tarjeta titulo="Listas de control" sinPadding>
      <div className="tabla-contenedor"><table className="tabla"><tbody>
        <tr><td><Link to="/listas/autorizados" style={{ textDecoration: 'none' }}><ShieldCheck size={14} color="var(--autorizado)" style={{ verticalAlign: -2 }} /> Autorizados vigentes</Link></td><td className="num"><b>{numero(l.autorizados_vigentes)}</b></td></tr>
        <tr><td><CalendarClock size={14} color="var(--no-registrado)" style={{ verticalAlign: -2 }} /> Vencen en {l.dias_aviso} días</td><td className="num"><b style={{ color: l.autorizados_por_vencer ? 'var(--no-registrado)' : undefined }}>{numero(l.autorizados_por_vencer)}</b></td></tr>
        <tr><td><Clock size={14} color="var(--text-4)" style={{ verticalAlign: -2 }} /> Autorizaciones vencidas</td><td className="num"><b>{numero(l.autorizados_vencidos)}</b></td></tr>
        <tr><td><Link to="/listas/alertas" style={{ textDecoration: 'none' }}><ShieldAlert size={14} color="var(--alerta)" style={{ verticalAlign: -2 }} /> Placas con alerta vigente</Link></td><td className="num"><b>{numero(l.alertas_vigentes)}</b></td></tr>
      </tbody></table></div>
    </Tarjeta>
  );
};

const Exactitud: React.FC<{ r: ResumenPanel }> = ({ r }) => {
  const { validadas, correctas } = r.exactitud_ocr;
  const pct = validadas ? correctas / validadas : null;
  return (
    <Tarjeta titulo="Exactitud de lectura (7 días)" subtitulo="Lectura automática frente a la placa confirmada por el personal">
      {!validadas ? <p className="texto-secundario">Aún no hay lecturas confirmadas por el personal para medir la exactitud.</p> : (
        <div className="pila" style={{ gap: 10 }}>
          <div className="fila" style={{ alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 32, fontWeight: 800 }}>{Math.round(pct! * 1000) / 10} %</span>
            <span className="texto-secundario">{numero(correctas)} de {numero(validadas)} lecturas correctas</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden' }}>
            <div style={{ width: `${pct! * 100}%`, height: '100%', background: 'var(--navy-700)' }} />
          </div>
          <Link to="/evaluacion" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}><Target size={14} /> Ver evaluación completa</Link>
        </div>
      )}
    </Tarjeta>
  );
};

const Administracion: React.FC = () => {
  const { datos: a, cargando, recargar } = useConsulta<PanelAdministracion>(() => api.get('/panel/administracion').then(r => r.data), []);
  const visible = usePaginaVisible();
  useEffect(() => { if (visible) recargar(true); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  if (cargando && !a) return <Tarjeta titulo="Administración"><Cargando /></Tarjeta>;
  if (!a) return null;
  const s = a.servicios;
  return (
    <>
      <div className="grid-kpi">
        <Kpi etiqueta="Usuarios activos" valor={numero(a.usuarios.activos)} icono={<UserCheck size={17} />} color="var(--autorizado)" fondo="var(--autorizado-bg)"
          pie={`${a.usuarios.por_rol.Admin} admin · ${a.usuarios.por_rol.Supervisor} supervisores · ${a.usuarios.por_rol.Operador} operadores`} />
        <Kpi etiqueta="Cuentas por verificar" valor={numero(a.usuarios.pendientes)} icono={<Mail size={17} />} color="var(--pendiente)" fondo="var(--pendiente-bg)" pie="Registro sin confirmar el correo" />
        <Kpi etiqueta="Cuentas bloqueadas" valor={numero(a.usuarios.bloqueados)} icono={<KeyRound size={17} />} color="var(--alerta)" fondo="var(--alerta-bg)" pie="Administrativo o por intentos" />
        <Kpi etiqueta="Accesos fallidos (24 h)" valor={numero(a.accesos_24h.fallidos)} icono={<ShieldAlert size={17} />} color="var(--no-registrado)" fondo="var(--no-registrado-bg)"
          pie={`${numero(a.accesos_24h.exitosos)} inicios de sesión correctos`} />
      </div>
      <div className="grid-3">
        <Tarjeta titulo="Servicios">
          <div className="pila" style={{ gap: 12, fontSize: 13 }}>
            <div className="fila" style={{ justifyContent: 'space-between' }}><span className="fila" style={{ gap: 8 }}><Database size={15} /> Base de datos</span><span className="fila" style={{ gap: 6 }}><span className="punto verde" /> En línea</span></div>
            <div className="fila" style={{ justifyContent: 'space-between' }}><span className="fila" style={{ gap: 8 }}><Server size={15} /> Motor ANPR</span>
              <span className="fila" style={{ gap: 6 }}><span className={`punto ${s.anpr.en_linea ? 'verde' : 'rojo'}`} />{s.anpr.en_linea ? `En línea · ${numero(s.anpr.fps_captura ?? 0)} fps` : s.anpr.error ?? 'Fuera de línea'}</span></div>
            <div className="fila" style={{ justifyContent: 'space-between' }}><span className="fila" style={{ gap: 8 }}><Mail size={15} /> Correo (SMTP)</span>
              <span className="fila" style={{ gap: 6 }}><span className={`punto ${s.correo.configurado ? 'verde' : 'ambar'}`} />{s.correo.configurado ? 'Configurado' : 'Sin configurar'}</span></div>
            {s.anpr.en_linea && <p className="texto-secundario" style={{ fontSize: 12 }}>Detector {s.anpr.detector} · OCR {s.anpr.ocr}{s.anpr.verificador ? ` · verificador ${s.anpr.verificador}` : ''}</p>}
          </div>
        </Tarjeta>
        <Tarjeta titulo="Actividad reciente" acciones={<Link to="/auditoria" className="btn btn-ghost btn-sm">Auditoría <ArrowRight size={14} /></Link>}>
          {a.actividad.length === 0 ? <p className="texto-secundario">Sin actividad registrada.</p> : (
            <ul className="linea-tiempo">
              {a.actividad.slice(0, 6).map((x, i) => (
                <li key={i}><div><strong>{x.accion.replace(/_/g, ' ').toLowerCase()}</strong><span>{x.actor ?? 'sistema'} · {relativo(x.fecha)}</span>{x.detalle && <span className="truncar" title={x.detalle}>{x.detalle}</span>}</div></li>
              ))}
            </ul>
          )}
        </Tarjeta>
        <Tarjeta titulo="Intentos de acceso fallidos" acciones={<Link to="/auditoria?fuente=accesos&resultado=fallo" className="btn btn-ghost btn-sm">Ver <ArrowRight size={14} /></Link>}>
          {a.ultimos_fallidos.length === 0 ? <p className="texto-secundario">Sin intentos fallidos recientes.</p> : (
            <ul className="linea-tiempo">
              {a.ultimos_fallidos.map((x, i) => <li key={i}><div><strong className="truncar">{x.email}</strong><span>{x.motivo} · {x.ip} · {relativo(x.fecha)}</span></div></li>)}
            </ul>
          )}
        </Tarjeta>
      </div>
    </>
  );
};

const PanelGestion: React.FC = () => {
  const { user, tieneRol } = useAuth();
  const { datos: r, cargando, error } = useResumen();
  return (
    <div className="pagina">
      <div className="fila" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 21, fontWeight: 800 }}>{saludo()}, {user?.nombre.split(' ')[0]}</h2>
          <p className="texto-secundario">Panel de {ROLES[user!.rol].toLowerCase()} · {r ? `actualizado ${relativo(r.generado)}` : 'cargando…'}</p>
        </div>
        <div className="fila">
          <Link to="/reportes" className="btn btn-secondary"><Activity size={16} /> Reportes</Link>
          <Link to="/monitoreo" className="btn btn-primary"><MonitorPlay size={16} /> Monitoreo en vivo</Link>
        </div>
      </div>
      {error && <Aviso tipo="error" style={{ marginBottom: 16 }}>{error}</Aviso>}
      <div className="pila">
        <KpisDelDia r={r} cargando={cargando} />
        {r && (
          <>
            <div className="grid-principal">
              <GraficoPorHora r={r} />
              <Tarjeta titulo="Distribución de hoy" subtitulo={`${numero(r.hoy.total)} ingresos · ${numero(r.hoy.validados)} confirmados por el personal`}>
                <BarraDistribucion valores={r.hoy as any} series={SERIES_ESTADO} />
              </Tarjeta>
            </div>
            <div className="grid-principal">
              <Tendencia r={r} />
              <div className="pila"><Listas r={r} /><Exactitud r={r} /></div>
            </div>
            <div className="grid-principal"><EstadoCamaras r={r} /><UltimasAlertas r={r} /></div>
          </>
        )}
        {tieneRol('Admin') && <>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginTop: 8 }}>Administración del sistema</h3>
          <Administracion />
        </>}
      </div>
    </div>
  );
};

/** Inicio según el rol: el operador ve su turno; administración y supervisión, la gestión. */
const Inicio: React.FC = () => {
  const { tieneRol } = useAuth();
  return tieneRol('Admin', 'Supervisor') ? <PanelGestion /> : <PanelOperador />;
};

export default Inicio;
