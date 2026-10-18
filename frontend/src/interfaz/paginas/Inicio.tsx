import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Camera, CarFront, CheckCircle2, ClipboardPlus, Clock, History, MonitorPlay, ShieldAlert, ShieldCheck,
  TrendingDown, TrendingUp,
} from 'lucide-react';
import api from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento, useReconexion } from '../../aplicacion/tiempoReal';
import { useConsulta, useDiferido, usePaginaVisible } from '../../aplicacion/hooks';
import type { Deteccion, ResumenPanel } from '../../dominio/tipos';
import { diaCorto, fecha, fechaHora, hora, numero, relativo, SERIES_ESTADO } from '../../dominio/formato';
import { Aviso, Cargando, FilasEsqueleto, InsigniaEstado, Kpi, Tarjeta, Vacio } from '../componentes/ui';
import { BarrasApiladas, BarrasHorizontales, Dona, Leyenda } from '../componentes/Graficos';
import { ConfianzaBadge, describirVehiculo, PlacaFoto, RegistroManualModal, TarjetaDeteccion, ValidarModal } from '../componentes/deteccion';
import GestionPermisos from './GestionPermisos';

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
  useReconexion(recargar);
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
    {r.camaras.length === 0 ? <Vacio titulo="No hay cámaras registradas" texto="El administrador registra los canales en Operación › Registro de cámaras." icono={<Camera size={22} />} /> : (
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

/** Panel del guardia: su turno, la cola de validación y accesos directos. */
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
      <div className="encabezado-pagina">
        <div>
          <h2>{saludo()}, {user?.nombre.split(' ')[0]}</h2>
          <p>Resumen del acceso vehicular de hoy · {fechaHora(new Date())}</p>
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

/* ─────────────── Panel de gestión (permiso alertas:gestionar: Administrador) ─────────────── */

/** Dona: cómo se repartieron los ingresos de hoy entre los estados de la decisión. */
const DistribucionHoy: React.FC<{ r: ResumenPanel }> = ({ r }) => (
  <Tarjeta titulo="Distribución de ingresos" subtitulo={`Hoy · ${numero(r.hoy.total)} ingresos, ${numero(r.hoy.validados)} confirmados por el personal`}>
    {r.hoy.total === 0
      ? <Vacio titulo="Sin ingresos hoy" texto="La distribución aparece con el primer paso registrado." icono={<Activity size={22} />} />
      : <Dona valores={r.hoy} series={SERIES_ESTADO} />}
  </Tarjeta>
);

/** Barras horizontales: ingresos de cada uno de los últimos 7 días, del más reciente al más antiguo. */
const UltimosSieteDias: React.FC<{ r: ResumenPanel }> = ({ r }) => {
  const total = r.tendencia.reduce((s, d) => s + d.total, 0);
  return (
    <Tarjeta titulo="Ingresos por día" subtitulo={`Últimos 7 días · ${numero(total)} ingresos`}>
      {total === 0 ? <Vacio titulo="Sin ingresos en los últimos 7 días" icono={<Activity size={22} />} /> : (
        <div className="pila" style={{ gap: 14 }}>
          <BarrasHorizontales series={SERIES_ESTADO}
            filas={[...r.tendencia].reverse().map(d => ({ etiqueta: diaCorto(d.fecha), total: d.total, valores: d }))} />
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}><Leyenda series={SERIES_ESTADO} /></div>
        </div>
      )}
    </Tarjeta>
  );
};

/** Los 50 ingresos más recientes en una tabla, actualizada en tiempo real. */
const IngresosRecientes: React.FC = () => {
  const navigate = useNavigate();
  const { datos, cargando, error, recargar } = useConsulta<Deteccion[]>(
    () => api.get('/detecciones/recientes', { params: { limite: 50 } }).then(r => r.data), []);
  const diferido = useDiferido(() => recargar(true), 1500);
  useEvento('deteccion:nueva', diferido);
  useEvento('deteccion:actualizada', diferido);
  useEvento('deteccion:eliminada', diferido);
  useEvento('deteccion:eliminadas', diferido);
  useReconexion(diferido);
  return (
    <Tarjeta titulo="Movimientos recientes" subtitulo="Los 50 últimos pasos registrados; se actualiza en tiempo real"
      acciones={<Link to="/detecciones" className="btn btn-ghost btn-sm"><History size={14} /> Historial completo <ArrowRight size={14} /></Link>} sinPadding>
      {error && <Aviso tipo="error" style={{ margin: 12 }}>{error}</Aviso>}
      <div className="tabla-contenedor" style={{ maxHeight: 560 }}>
        <table className="tabla">
          <thead><tr>
            <th className="num" style={{ width: 44 }}>#</th><th>Placa</th><th>Fecha y hora</th><th>Estado</th><th>Cámara</th>
            <th className="ocultar-movil">Vehículo / titular</th><th className="num ocultar-movil">Confianza OCR</th><th>Validación</th>
          </tr></thead>
          <tbody>
            {cargando && !datos ? <FilasEsqueleto columnas={8} /> : (datos ?? []).map((d, i) => (
              <tr key={d.id} className="clic" onClick={() => navigate(`/detecciones/${d.id}`)}>
                <td className="num texto-secundario">{i + 1}</td>
                <td className="nowrap"><PlacaFoto d={d} /></td>
                <td className="nowrap"><strong style={{ color: 'var(--text)', fontWeight: 600 }}>{hora(d.fecha_hora_ingreso)}</strong><span className="secundario">{fecha(d.fecha_hora_ingreso)}</span></td>
                <td><InsigniaEstado estado={d.estado_validacion} procesando={d.estado_procesamiento === 'pendiente_ocr'} /></td>
                <td>{d.camara ? <>{d.camara.nombre}<span className="secundario">{d.tipo_movimiento === 'salida' ? 'Salida' : 'Ingreso'} · {d.camara.ubicacion}</span></> : <span className="texto-secundario">{d.fuente === 'manual' ? 'Registro manual' : d.tipo_movimiento === 'salida' ? 'Salida' : '—'}</span>}</td>
                <td className="ocultar-movil" style={{ maxWidth: 240 }}>
                  <span className="truncar" style={{ display: 'block' }}>{d.alerta ? <b style={{ color: 'var(--alerta)' }}>{d.alerta.motivo}</b> : d.autorizado?.propietario ?? describirVehiculo(d)}</span>
                </td>
                <td className="num ocultar-movil"><ConfianzaBadge valor={d.confianza_ocr} /></td>
                <td>{d.validado_manualmente
                  ? <span title={d.validacion?.usuario?.email}>{d.validacion?.usuario?.nombre ?? 'Personal'}</span>
                  : <span className="texto-secundario">Automática</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {datos && datos.length === 0 && (
        <Vacio titulo="Aún no hay ingresos registrados" texto="Los pasos vehiculares aparecerán aquí en cuanto el motor ANPR los registre." icono={<CarFront size={22} />} />
      )}
    </Tarjeta>
  );
};

/**
 * Dashboard de gestión, simple como el de vigilance-heart: indicadores del día, la distribución de
 * hoy, los últimos 7 días y los 50 ingresos recientes. Servicios, cuentas, listas de control y
 * exactitud están en Estado del sistema.
 */
const PanelGestion: React.FC = () => {
  const { user } = useAuth();
  const { datos: r, cargando, error } = useResumen();
  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <div>
          <h2>Dashboard</h2>
          <p>Vista general del acceso vehicular · {saludo()}, {user?.nombre.split(' ')[0]} · {r ? `actualizado ${relativo(r.generado)}` : 'cargando…'}</p>
        </div>
        <div className="fila">
          <Link to="/reportes" className="btn btn-secondary"><Activity size={16} /> Reportes</Link>
          <Link to="/monitoreo" className="btn btn-primary"><MonitorPlay size={16} /> Monitoreo en vivo</Link>
        </div>
      </div>
      {error && <Aviso tipo="error" style={{ marginBottom: 16 }}>{error}</Aviso>}
      <div className="pila">
        <KpisDelDia r={r} cargando={cargando} />
        {r
          ? <div className="grid-2"><DistribucionHoy r={r} /><UltimosSieteDias r={r} /></div>
          : <Tarjeta titulo="Distribución de ingresos"><Cargando /></Tarjeta>}
        <IngresosRecientes />
      </div>
    </div>
  );
};

/**
 * Inicio según los permisos: quien supervisa (reportes y alertas) ve la gestión; el gestor de
 * permisos, su única vista de gestión de permisos; el guardia, su turno.
 */
const Inicio: React.FC = () => {
  const { puede } = useAuth();
  if (puede('alertas:gestionar')) return <PanelGestion />;
  if (puede('padron:gestionar')) return <GestionPermisos />;
  if (puede('operacion:monitorear')) return <PanelOperador />;
  return <div className="pagina"><div className="tarjeta" style={{ padding: 24 }}>Su cuenta no tiene permisos asignados. Contacte al administrador.</div></div>;
};

export default Inicio;
