import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, Camera, ClipboardPlus, Cpu, Pause, Play, Search, ShieldAlert, ShieldCheck, Trash2, Webcam } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta, usePaginaVisible } from '../lib/hooks';
import type { Camara, Deteccion, EstadoAnpr } from '../lib/tipos';
import { ESTADOS, fecha, fechaHora, hora, numero, relativo } from '../lib/formato';
import { Aviso, Cargando, InsigniaEstado, Modal, Placa, Segmentado, Tarjeta, Vacio } from '../components/ui';
import { ImagenEvidencia, RegistroManualModal, TarjetaDeteccion, ValidarModal } from '../components/deteccion';
import { VisorZoom } from '../components/ZoomDual';
import { EliminarUno, EliminarVarios } from '../components/EliminarDetecciones';
import { alCambiarSonido, fijarSonido, sonarAutorizado, sonarDenegado, sonidoActivo } from '../lib/avisos';
import { PERFILES, PerfilVideo, VisorVideo, WebcamPrueba } from '../components/video';
import { VisorEnVivo } from '../components/envivo';
import { useNotificar } from '../components/Notificaciones';

const MAX_FEED = 30;
const CLAVE_PERFIL = 'anpr_perfil_video';
const CLAVE_MODO = 'anpr_modo_video';

const leer = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const guardar = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

/** Consulta rápida de una placa: listas y últimos ingresos. */
const BuscarPlacaModal: React.FC<{ onCerrar: () => void }> = ({ onCerrar }) => {
  const [placa, setPlaca] = useState('');
  const [resultado, setResultado] = useState<any>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const buscar = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = placa.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (p.length < 3) return;
    setCargando(true); setError(null);
    try { setResultado((await api.get(`/detecciones/buscar-placa/${p}`)).data); } catch (err) { setError(mensajeError(err)); } finally { setCargando(false); }
  };
  return (
    <Modal titulo="Consultar placa" subtitulo="Situación en las listas de control e ingresos registrados" onCerrar={onCerrar} tamano="ancho">
      <form onSubmit={buscar} className="fila" style={{ marginBottom: 16 }}>
        <input className="input placa-input" style={{ maxWidth: 220 }} value={placa} onChange={e => setPlaca(e.target.value.toUpperCase())} maxLength={10} placeholder="ABC1234" autoFocus />
        <button className="btn btn-navy" disabled={cargando || placa.replace(/[^A-Z0-9]/gi, '').length < 3}><Search size={15} /> Consultar</button>
      </form>
      {cargando && <Cargando alto={100} />}
      {error && <Aviso tipo="error">{error}</Aviso>}
      {resultado && !cargando && (
        <div className="pila">
          {resultado.estado === 'alerta' && <Aviso tipo="error"><b>{resultado.placa} está en la lista de alertas</b> · {resultado.alerta.motivo} (nivel {resultado.alerta.nivel_alerta}{resultado.alerta.coincidencia === 'aproximada' ? `, coincidencia aproximada con ${resultado.alerta.placa}` : ''})</Aviso>}
          {resultado.estado === 'autorizado' && <Aviso tipo="exito"><b>{resultado.placa} está autorizada</b> · {resultado.autorizado.propietario}{resultado.autorizado.departamento ? ` · ${resultado.autorizado.departamento}` : ''}</Aviso>}
          {resultado.estado === 'no_registrado' && <Aviso tipo="advertencia"><b>{resultado.placa}</b> no consta en el padrón de autorizados ni en la lista de alertas vigentes.</Aviso>}
          <div>
            <h4 style={{ fontSize: 13, marginBottom: 8 }}>Últimos ingresos</h4>
            {resultado.ultimos_ingresos.length === 0 ? <p className="texto-secundario">Sin ingresos registrados con esta placa.</p> : (
              <div className="tabla-contenedor"><table className="tabla"><thead><tr><th>Fecha</th><th>Estado</th><th>Cámara</th></tr></thead><tbody>
                {resultado.ultimos_ingresos.map((d: Deteccion) => (
                  <tr key={d.id} className="clic" onClick={() => { onCerrar(); navigate(`/detecciones/${d.id}`); }}>
                    <td>{fechaHora(d.fecha_hora_ingreso)}</td><td><InsigniaEstado estado={d.estado_validacion} /></td><td>{d.camara?.nombre ?? '—'}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

const Monitoreo: React.FC = () => {
  const { user, tieneRol } = useAuth();
  const notificar = useNotificar();
  const visible = usePaginaVisible();
  const [perfil, setPerfil] = useState<PerfilVideo>(() => (leer(CLAVE_PERFIL, 'media') as PerfilVideo) in PERFILES ? leer(CLAVE_PERFIL, 'media') as PerfilVideo : 'media');
  const [pausado, setPausado] = useState(false);
  const [fuente, setFuente] = useState<'camara' | 'webcam'>('camara');
  // WebRTC (MediaMTX, sin re-codificar, ~0,2–0,5 s) o compatibilidad (JPEG por WebSocket desde el motor)
  const [modo, setModo] = useState<'webrtc' | 'compat'>(() => (leer(CLAVE_MODO, 'webrtc') === 'compat' ? 'compat' : 'webrtc'));
  const cambiarModo = (m: 'webrtc' | 'compat') => { setModo(m); guardar(CLAVE_MODO, m); };
  const [sonido, setSonido] = useState(sonidoActivo);
  useEffect(() => alCambiarSonido(setSonido), []);
  const [feed, setFeed] = useState<Deteccion[]>([]);
  const [cargandoFeed, setCargandoFeed] = useState(true);
  const [resaltada, setResaltada] = useState<number | null>(null);
  const [validando, setValidando] = useState<Deteccion | null>(null);
  const [manual, setManual] = useState(false);
  const [buscar, setBuscar] = useState(false);
  const [cambiando, setCambiando] = useState(false);
  const [reinicioVideo, setReinicioVideo] = useState(0);
  const [eliminando, setEliminando] = useState<Deteccion | null>(null);
  const [eliminarTodos, setEliminarTodos] = useState(false);
  const esAdmin = tieneRol('Admin');
  const puedeCambiarCamara = tieneRol('Admin', 'Supervisor');

  const { datos: camaras } = useConsulta<Camara[]>(() => api.get('/camaras').then(r => r.data), []);
  const estadoMotor = useConsulta<EstadoAnpr>(() => api.get('/monitoreo/estado').then(r => r.data), []);

  // Estado del motor: se refresca cada 30 s solo mientras la pestaña está visible
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => estadoMotor.recargar(true), 30000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const cargarFeed = useCallback(() => {
    api.get('/detecciones/recientes', { params: { limite: MAX_FEED } })
      .then(r => setFeed(r.data)).catch(() => undefined).finally(() => setCargandoFeed(false));
  }, []);
  // Carga inicial y resincronización al volver a la pestaña (por eventos perdidos mientras estaba oculta)
  useEffect(() => { if (visible) cargarFeed(); }, [visible, cargarFeed]);

  const insertar = (d: Deteccion) => {
    setFeed(f => [d, ...f.filter(x => x.id !== d.id)].slice(0, MAX_FEED));
    setResaltada(d.id);
    window.setTimeout(() => setResaltada(r => (r === d.id ? null : r)), 3000);
  };

  useEvento<Deteccion>('deteccion:nueva', insertar);
  useEvento<Deteccion>('deteccion:actualizada', d => {
    setFeed(f => (f.some(x => x.id === d.id) ? f.map(x => (x.id === d.id ? d : x)) : [d, ...f].slice(0, MAX_FEED)));
    setResaltada(d.id);
    window.setTimeout(() => setResaltada(r => (r === d.id ? null : r)), 3000);
  });
  useEvento<{ id: number }>('deteccion:eliminada', ({ id }) => setFeed(f => f.filter(x => x.id !== id)));
  useEvento('deteccion:eliminadas', () => cargarFeed());
  useEvento<{ camara_id: number; nombre: string; por: string }>('monitoreo:camara', e => {
    estadoMotor.recargar(true);
    setReinicioVideo(x => x + 1);
    if (e.por !== user?.nombre) notificar('info', `El motor ANPR ahora procesa ${e.nombre}`, `Cambio realizado por ${e.por}`);
  });

  const cambiarCamara = async (id: number) => {
    setCambiando(true);
    try {
      const r = await api.post('/monitoreo/camara-activa', { camara_id: id });
      notificar('exito', r.data.message);
    } catch (e) {
      notificar('error', 'No se pudo cambiar la cámara', mensajeError(e));
    } finally {
      setCambiando(false);
      estadoMotor.recargar(true);
    }
  };

  const motor = estadoMotor.datos;
  const camaraActiva = camaras?.find(c => c.id === motor?.camara_activa?.id);
  const pendientes = feed.filter(d => d.estado_validacion === 'pendiente_revision' && !d.validado_manualmente && d.estado_procesamiento !== 'pendiente_ocr');
  const ultima = feed.find(d => d.estado_procesamiento !== 'pendiente_ocr') ?? null;

  return (
    <div className="pagina ancha">
      <div className="grid-principal" style={{ gridTemplateColumns: 'minmax(0, 1.9fr) minmax(320px, 1fr)' }}>
        {/* ── Video y controles ── */}
        <div className="pila">
          {motor?.en_linea && motor.camara_activa && !motor.camara_activa.conectada && fuente === 'camara' && (
            <Aviso tipo="advertencia">
              <b>El motor está conectado a {camaraActiva?.nombre ?? 'la cámara'}, pero no recibe video.</b> Si es un celular, mantenga la app
              de cámara abierta en primer plano y la pantalla encendida (Android pausa la cámara al bloquearse). En una cámara IP, revise la ruta
              del flujo en Administración › Cámaras con “Probar conexión”.
            </Aviso>
          )}
          {motor?.en_linea && motor.fuente_externa && fuente === 'camara' && (
            <Aviso tipo="advertencia">
              {camaras?.some(c => c.activa)
                ? <>El motor ANPR todavía procesa su fuente de arranque. {puedeCambiarCamara ? 'Seleccione la cámara en la lista para asignarla.' : 'Se asignará automáticamente en unos segundos.'}</>
                : <>No hay cámaras habilitadas. {tieneRol('Admin') ? <>Registre una en <a href="/camaras">Administración › Cámaras</a>.</> : 'Solicite al administrador que registre una.'}</>}
            </Aviso>
          )}
          <Tarjeta sinPadding>
            <div className="fila" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
              <div className="fila" style={{ gap: 8, minWidth: 0 }}>
                <Camera size={16} color="var(--text-3)" />
                {puedeCambiarCamara && camaras && camaras.length > 0 && fuente === 'camara' ? (
                  <select className="select" style={{ height: 32, width: 'auto', maxWidth: 280 }} value={motor?.camara_activa?.id ?? ''} disabled={cambiando || !motor?.en_linea}
                    onChange={e => e.target.value && cambiarCamara(Number(e.target.value))} aria-label="Cámara que procesa el motor ANPR">
                    <option value="" disabled>Seleccione la cámara…</option>
                    {camaras.filter(c => c.activa).map(c => <option key={c.id} value={c.id}>{c.nombre} · {c.ubicacion}</option>)}
                  </select>
                ) : (
                  <strong className="truncar" style={{ fontSize: 13.5 }}>
                    {fuente === 'webcam' ? 'Webcam del navegador' : camaraActiva ? `${camaraActiva.nombre} · ${camaraActiva.ubicacion}` : 'Cámara configurada en el motor'}
                  </strong>
                )}
              </div>
              <div className="fila" style={{ marginLeft: 'auto', gap: 8 }}>
                {tieneRol('Admin') && (
                  <Segmentado valor={fuente} onCambiar={setFuente} opciones={[
                    { valor: 'camara', etiqueta: <><Camera size={13} /> Cámara</> },
                    { valor: 'webcam', etiqueta: <><Webcam size={13} /> Webcam</> },
                  ]} />
                )}
                {fuente === 'camara' && (
                  <>
                    <Segmentado valor={modo} onCambiar={cambiarModo} opciones={[
                      { valor: 'webrtc', etiqueta: 'Tiempo real' },
                      { valor: 'compat', etiqueta: 'Compatibilidad' },
                    ]} />
                    {modo === 'compat' && (
                      <select className="select" style={{ height: 32, width: 'auto' }} value={perfil} aria-label="Calidad de video"
                        onChange={e => { const p = e.target.value as PerfilVideo; setPerfil(p); guardar(CLAVE_PERFIL, p); }}>
                        {(Object.keys(PERFILES) as PerfilVideo[]).map(p => <option key={p} value={p}>{PERFILES[p].etiqueta}</option>)}
                      </select>
                    )}
                    <button className="btn btn-secondary btn-sm" onClick={() => setPausado(p => !p)}>
                      {pausado ? <><Play size={14} /> Reanudar</> : <><Pause size={14} /> Pausar video</>}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div style={{ padding: 12 }}>
              {fuente === 'webcam' ? <WebcamPrueba />
                : modo === 'compat' ? <VisorVideo perfil={perfil} pausado={pausado} claveReinicio={reinicioVideo} />
                  : !motor && estadoMotor.cargando ? <div style={{ aspectRatio: '16 / 9', background: '#050b16', borderRadius: 10 }} />
                    : <VisorEnVivo camaraId={motor?.camara_activa?.id ?? null} pausado={pausado} claveReinicio={reinicioVideo}
                        onFallo={m => { cambiarModo('compat'); notificar('advertencia', 'Se activó el modo de compatibilidad', `WebRTC no disponible: ${m}`); }} />}
            </div>
            <div className="fila" style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', gap: 16, fontSize: 12.5, color: 'var(--text-3)' }}>
              <span className="fila" style={{ gap: 6 }}>
                <span className={`punto ${motor?.en_linea ? 'verde' : estadoMotor.cargando ? 'gris' : 'rojo'}`} />
                Motor ANPR {motor?.en_linea ? 'en línea' : estadoMotor.cargando ? '…' : `fuera de línea${motor?.error ? ` (${motor.error})` : ''}`}
              </span>
              {motor?.en_linea && <>
                <span className="fila" style={{ gap: 6 }}><Cpu size={13} /> Captura {numero(motor.fps_captura ?? 0)} fps · análisis {numero(motor.fps_procesamiento ?? 0)} fps</span>
                {motor.camara_activa && <span className="fila" style={{ gap: 6 }}><span className={`punto ${motor.camara_activa.conectada ? 'verde' : 'ambar'}`} /> Señal {motor.camara_activa.conectada ? 'recibida' : 'sin recibir'}</span>}
                <span className="ocultar-movil truncar" title={`${motor.detector} · ${motor.ocr}`}>Detector {motor.detector} · OCR {motor.ocr}</span>
              </>}
            </div>
          </Tarjeta>

          {/* Último paso: tamaño destacado para la garita */}
          <Tarjeta titulo="Último paso registrado" acciones={
            <div className="fila">
              <button className="btn btn-secondary btn-sm" onClick={() => setBuscar(true)}><Search size={14} /> Consultar placa</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setManual(true)}><ClipboardPlus size={14} /> Ingreso manual</button>
              <button className={`btn btn-sm ${sonido ? 'btn-secondary' : 'btn-ghost'}`} title={sonido ? 'Silenciar alertas' : 'Activar sonido de alertas'}
                onClick={() => fijarSonido(!sonido)}>
                {sonido ? <Bell size={14} /> : <BellOff size={14} />} {sonido ? 'Sonido activo' : 'Silenciado'}
              </button>
              <button className="btn btn-ghost btn-sm" title="Probar el sonido de vehículo autorizado" disabled={!sonido} onClick={sonarAutorizado}>
                <ShieldCheck size={14} color="var(--autorizado)" /> Probar autorizado</button>
              <button className="btn btn-ghost btn-sm" title="Probar el sonido de acceso no autorizado" disabled={!sonido} onClick={sonarDenegado}>
                <ShieldAlert size={14} color="var(--alerta)" /> Probar alerta</button>
            </div>}>
            {!ultima ? <Vacio titulo="Aún no hay pasos registrados" texto="Las detecciones aparecerán aquí en cuanto el motor ANPR registre un vehículo." /> : (
              <div className="fila" style={{ alignItems: 'stretch', gap: 16, flexWrap: 'wrap' }}>
                <div className="pila" style={{ gap: 10, minWidth: 220 }}>
                  <Placa valor={ultima.placa} grande />
                  <InsigniaEstado estado={ultima.estado_validacion} />
                  <span className="texto-secundario">{fechaHora(ultima.fecha_hora_ingreso)} · {relativo(ultima.fecha_hora_ingreso)}</span>
                  <span style={{ fontSize: 13 }}>
                    {ultima.alerta ? <b style={{ color: 'var(--alerta)' }}>{ultima.alerta.motivo}</b>
                      : ultima.autorizado ? <>{ultima.autorizado.propietario}{ultima.autorizado.departamento ? ` · ${ultima.autorizado.departamento}` : ''}</>
                        : ESTADOS[ultima.estado_validacion].etiqueta}
                  </span>
                  {ultima.estado_validacion === 'pendiente_revision' && !ultima.validado_manualmente && (
                    <button className="btn btn-navy btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setValidando(ultima)}>Validar ahora</button>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 240 }} className="grid-2">
                  <TarjetaImagen d={ultima} ruta={ultima.imagen_placa} titulo="Placa" contain />
                  <TarjetaImagen d={ultima} ruta={ultima.imagen_vehiculo} titulo="Vehículo" />
                </div>
              </div>
            )}
          </Tarjeta>

          <TablaIngresosRecientes items={feed.filter(d => d.estado_procesamiento !== 'pendiente_ocr').slice(0, 12)}
            onValidar={setValidando} onEliminar={esAdmin ? setEliminando : undefined} />
        </div>

        {/* ── Feed en tiempo real ── */}
        <div className="pila">
          {pendientes.length > 0 && (
            <Aviso tipo="info">
              <b>{pendientes.length} {pendientes.length === 1 ? 'paso requiere' : 'pasos requieren'} validación</b> en el feed. Use “Validar” en cada tarjeta.
            </Aviso>
          )}
          <Tarjeta titulo="Detecciones en tiempo real" subtitulo="Actualización instantánea, sin recargar" sinPadding
            acciones={esAdmin && feed.length > 0 ? <button className="btn btn-danger btn-sm" onClick={() => setEliminarTodos(true)}><Trash2 size={14} /> Eliminar todos</button> : undefined}>
            <div className="pila" style={{ gap: 8, padding: 12, maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
              {cargandoFeed ? <Cargando /> : feed.length === 0
                ? <Vacio titulo="Sin detecciones" texto="Cuando el motor registre un vehículo aparecerá aquí de inmediato." />
                : feed.map(d => <TarjetaDeteccion key={d.id} d={d} onValidar={setValidando} onEliminar={esAdmin ? setEliminando : undefined} resaltada={resaltada === d.id} />)}
            </div>
          </Tarjeta>
        </div>
      </div>

      {validando && <ValidarModal d={validando} onCerrar={() => setValidando(null)} />}
      {manual && <RegistroManualModal onCerrar={() => setManual(false)} />}
      {buscar && <BuscarPlacaModal onCerrar={() => setBuscar(false)} />}
      {eliminando && <EliminarUno d={eliminando} onCerrar={() => setEliminando(null)} onEliminada={id => setFeed(f => f.filter(x => x.id !== id))} />}
      {eliminarTodos && <TotalRegistros>{total => (
        <EliminarVarios total={total} descripcion="Todos los registros de ingreso del sistema" onCerrar={() => setEliminarTodos(false)} onHecho={() => cargarFeed()} />
      )}</TotalRegistros>}
    </div>
  );
};

const TarjetaImagen: React.FC<{ d: Deteccion; ruta: string | null; titulo: string; contain?: boolean }> = ({ d, ruta, titulo, contain }) => {
  const [zoom, setZoom] = useState(false);
  return (
    <div>
      <span className="etiqueta-campo">{titulo}</span>
      <div style={{ marginTop: 6 }} className="miniatura-zoom" title="Ampliar evidencia">
        <ImagenEvidencia ruta={ruta} alt={titulo} alto={150} ajuste={contain ? 'contain' : 'cover'} fondoOscuro={contain} onClick={() => setZoom(true)} />
      </div>
      {zoom && <VisorZoom d={d} onCerrar={() => setZoom(false)} />}
    </div>
  );
};

/**
 * Ingresos recientes (como la tabla de la versión anterior): filas verdes para autorizados,
 * rojas para alertas, con la marca OK / ALERTA junto a la placa. Usa los mismos datos del
 * feed en tiempo real, sin consultas adicionales.
 */
const TablaIngresosRecientes: React.FC<{ items: Deteccion[]; onValidar: (d: Deteccion) => void; onEliminar?: (d: Deteccion) => void }> = ({ items, onValidar, onEliminar }) => {
  const navigate = useNavigate();
  const [zoom, setZoom] = useState<Deteccion | null>(null);
  return (
    <Tarjeta titulo="Ingresos recientes" subtitulo="Últimos pasos procesados · verde: autorizado · rojo: alerta" sinPadding>
      {items.length === 0 ? <Vacio titulo="Sin ingresos procesados" texto="Los ingresos aparecerán aquí en cuanto el motor termine de leer cada placa." /> : (
        <div className="tabla-contenedor">
          <table className="tabla">
            <thead><tr><th>Fecha y hora</th><th>Placa</th><th>Vehículo / titular</th><th className="num ocultar-movil">Confianza</th><th>Evidencia</th><th /></tr></thead>
            <tbody>
              {items.map(d => {
                const aut = d.estado_validacion === 'autorizado';
                const ale = d.estado_validacion === 'alerta';
                return (
                  <tr key={d.id} className={`clic${aut ? ' fila-autorizado' : ale ? ' fila-alerta' : ''}`} onClick={() => navigate(`/detecciones/${d.id}`)}>
                    <td className="nowrap"><strong style={{ color: 'var(--text)', fontWeight: 700 }}>{hora(d.fecha_hora_ingreso)}</strong><span className="secundario">{fecha(d.fecha_hora_ingreso)}</span></td>
                    <td className="nowrap">
                      <span className="mono" style={{ fontWeight: 900, letterSpacing: 1.5, fontSize: 14, color: aut ? 'var(--autorizado)' : ale ? 'var(--alerta)' : 'var(--pendiente)' }}>{d.placa ?? 'SIN LECTURA'}</span>
                      {aut && <span className="marca-estado ok">OK</span>}
                      {ale && <span className="marca-estado alerta">ALERTA</span>}
                    </td>
                    <td style={{ maxWidth: 240 }}>
                      <span className="truncar" style={{ display: 'block', color: aut ? 'var(--autorizado)' : ale ? 'var(--alerta)' : undefined, fontWeight: aut || ale ? 600 : undefined }}>
                        {aut ? `✓ ${d.autorizado?.propietario ?? 'Padrón institucional'}` : ale ? `⚠ ${d.alerta?.motivo ?? 'Lista de alertas'}` : ESTADOS[d.estado_validacion].etiqueta}
                      </span>
                      <span className="secundario truncar">{[d.tipo_vehiculo, d.camara?.nombre].filter(Boolean).join(' · ') || '—'}</span>
                    </td>
                    <td className="num ocultar-movil">{d.confianza_ocr !== null ? `${(d.confianza_ocr * 100).toFixed(1)} %` : '—'}</td>
                    <td onClick={e => { e.stopPropagation(); setZoom(d); }} className="miniatura-zoom" title="Ampliar evidencia" style={{ width: 86 }}>
                      <ImagenEvidencia ruta={d.imagen_placa || d.imagen_vehiculo} alt="" alto={36} ajuste="contain" fondoOscuro />
                    </td>
                    <td className="acciones-celda" onClick={e => e.stopPropagation()}>
                      {d.estado_validacion === 'pendiente_revision' && !d.validado_manualmente
                        ? <button className="btn btn-navy btn-sm" onClick={() => onValidar(d)}>Validar</button>
                        : <button className="btn btn-ghost btn-sm" onClick={() => onValidar(d)}>{d.validado_manualmente ? 'Validado' : 'Corregir'}</button>}
                      {onEliminar && <button className="btn btn-ghost btn-sm btn-icono" title="Eliminar registro" aria-label="Eliminar registro" onClick={() => onEliminar(d)}><Trash2 size={14} color="var(--alerta)" /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {zoom && <VisorZoom d={zoom} onCerrar={() => setZoom(null)} />}
    </Tarjeta>
  );
};

/** Consulta el total de registros antes de mostrar la eliminación masiva. */
const TotalRegistros: React.FC<{ children: (total: number) => React.ReactNode }> = ({ children }) => {
  const { datos } = useConsulta<number>(() => api.get('/detecciones', { params: { tamano: 5 } }).then(r => r.data.total), []);
  return datos === null ? null : <>{children(datos)}</>;
};

export default Monitoreo;
