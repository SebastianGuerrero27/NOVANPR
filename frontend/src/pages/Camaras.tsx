import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, Cpu, Crop, Edit3, Loader2, Play, Plus, RadioTower, RefreshCw, Trash2 } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta } from '../lib/hooks';
import type { Camara, EstadoAnpr } from '../lib/tipos';
import { numero, relativo } from '../lib/formato';
import { Aviso, Confirmar, Interruptor, Modal, Tarjeta, Vacio } from '../components/ui';
import { useNotificar } from '../components/Notificaciones';
import { FormularioCamara, PanelDiagnostico, ResultadoDiagnostico } from '../components/FormularioCamara';
import { ReproductorPrueba } from '../components/envivo';
import { EditorRoi } from '../components/EditorRoi';

const ESTADO: Record<Camara['estado'], { p: string; t: string }> = {
  EN_LINEA: { p: 'verde', t: 'En línea' }, SIN_CONEXION: { p: 'rojo', t: 'Sin conexión' }, SIN_VERIFICAR: { p: 'gris', t: 'Sin verificar' },
};

const Camaras: React.FC = () => {
  const notificar = useNotificar();
  const { datos, cargando, error, setDatos } = useConsulta<Camara[]>(() => api.get('/camaras').then(r => r.data), []);
  const [editando, setEditando] = useState<Camara | 'nueva' | null>(null);
  const [eliminando, setEliminando] = useState<Camara | null>(null);
  const [probando, setProbando] = useState<number | 'todas' | null>(null);
  const [diagnostico, setDiagnostico] = useState<{ camara: Camara; resultado: ResultadoDiagnostico } | null>(null);
  const [reproduciendo, setReproduciendo] = useState<Camara | null>(null);
  const [area, setArea] = useState<Camara | null>(null);
  const motor = useConsulta<EstadoAnpr>(() => api.get('/monitoreo/estado').then(r => r.data), []);
  useEvento('monitoreo:camara', () => motor.recargar(true));

  const reemplazar = (c: Camara) => setDatos(l => l && (l.some(x => x.id === c.id) ? l.map(x => (x.id === c.id ? { ...x, ...c } : x)) : [...l, c]));
  useEvento<Camara>('camara:actualizada', reemplazar);
  useEvento<{ id: number }>('camara:eliminada', ({ id }) => setDatos(l => l && l.filter(x => x.id !== id)));
  useEvento<Partial<Camara> & { id: number }>('camara:estado', e => setDatos(l => l && l.map(x => (x.id === e.id ? { ...x, ...e } : x))));

  const probar = async (c: Camara) => {
    setProbando(c.id);
    try {
      const r = await api.post(`/camaras/${c.id}/ping`);
      setDiagnostico({ camara: c, resultado: r.data });
    } catch (e) {
      notificar('error', 'No se pudo probar la conexión', mensajeError(e));
    } finally { setProbando(null); }
  };
  const probarTodas = async () => {
    setProbando('todas');
    try {
      const r = await api.post('/camaras/ping-all');
      notificar('info', 'Prueba de conectividad completada', `${r.data.en_linea} de ${r.data.total} cámaras habilitadas en línea.`);
    } catch (e) {
      notificar('error', 'No se pudo probar las cámaras', mensajeError(e));
    } finally { setProbando(null); }
  };
  const alternar = async (c: Camara) => {
    try {
      const r = await api.patch(`/camaras/${c.id}/toggle`);
      reemplazar(r.data.camera);
      notificar('exito', r.data.message);
    } catch (e) { notificar('error', 'No se pudo cambiar el estado', mensajeError(e)); }
  };

  return (
    <div className="pagina">
      <div className="pila">
        <Aviso tipo="info"><b>Ping</b> comprueba la conectividad de red y el servicio RTSP de la cámara; <b>Play</b> reproduce el flujo real para confirmar que el video llega; <b>Área</b> delimita la zona donde el motor busca placas. Cada minuto se verifica automáticamente el flujo RTSP de las cámaras habilitadas.</Aviso>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Tarjeta titulo="Cámaras registradas" subtitulo={datos ? `${datos.length} cámaras · ${datos.filter(c => c.activa && c.estado === 'EN_LINEA').length} en línea` : undefined}
          acciones={<>
            <button className="btn btn-secondary btn-sm" onClick={probarTodas} disabled={probando !== null || !datos?.length}>
              {probando === 'todas' ? <Loader2 size={14} className="girar" /> : <RefreshCw size={14} />} Probar todas</button>
            <button className="btn btn-navy btn-sm" onClick={() => setEditando('nueva')}><Plus size={14} /> Registrar cámara</button>
          </>} sinPadding>
          {cargando && !datos ? <div style={{ padding: 20 }}><div className="esqueleto" style={{ height: 120 }} /></div> : datos && datos.length === 0 ? (
            <Vacio titulo="Aún no hay cámaras" icono={<Camera size={22} />} texto="Registre la primera cámara IP con su URL RTSP para que el motor ANPR pueda procesarla."
              accion={<button className="btn btn-navy btn-sm" onClick={() => setEditando('nueva')}><Plus size={14} /> Registrar cámara</button>} />
          ) : (
            <div className="tabla-contenedor"><table className="tabla">
              <thead><tr><th>Cámara</th><th>Conectividad</th><th className="ocultar-movil">URL RTSP</th><th className="num">Detecciones</th><th>Habilitada</th><th /></tr></thead>
              <tbody>
                {datos?.map(c => {
                  const e = ESTADO[c.estado] ?? ESTADO.SIN_VERIFICAR;
                  return (
                    <tr key={c.id} className={c.activa ? '' : 'inactivo'}>
                      <td><strong style={{ color: 'var(--text)' }}>{c.nombre}</strong><span className="secundario">{c.ubicacion}</span>
                        {motor.datos?.camara_activa?.id === c.id && <span className="insignia info" style={{ marginTop: 4 }}><Cpu size={12} /> Procesando en el motor ANPR</span>}
                        {c.roi && <span className="insignia" style={{ marginTop: 4 }} title="El motor solo busca placas dentro del área marcada"><Crop size={12} /> Área de interés ({c.roi.length} vértices)</span>}</td>
                      <td>
                        <span className="fila" style={{ gap: 6 }}><span className={`punto ${c.activa ? e.p : 'gris'}`} />{c.activa ? e.t : 'Deshabilitada'}{c.activa && c.tiempo_respuesta_ms !== null && c.estado === 'EN_LINEA' && <span className="texto-secundario">· {c.tiempo_respuesta_ms} ms</span>}</span>
                        <span className="secundario">{c.ultimo_ping ? `${c.mensaje_ping ?? ''} · ${relativo(c.ultimo_ping)}` : 'Aún no verificada'}</span>
                      </td>
                      <td className="ocultar-movil mono truncar" style={{ fontSize: 12, maxWidth: 320 }} title={c.rtsp_url}>{c.rtsp_url}</td>
                      <td className="num">{c.detecciones ? <Link to={`/detecciones?camara=${c.id}`}>{numero(c.detecciones)}</Link> : '0'}</td>
                      <td><Interruptor activo={c.activa} onCambiar={() => alternar(c)} etiqueta={c.activa ? 'Deshabilitar cámara' : 'Habilitar cámara'} /></td>
                      <td className="acciones-celda">
                        <button className="btn btn-secondary btn-sm" title="Ping de red y diagnóstico RTSP" onClick={() => probar(c)} disabled={probando !== null}>
                          {probando === c.id ? <Loader2 size={14} className="girar" /> : <RadioTower size={14} />} Ping</button>
                        <button className="btn btn-secondary btn-sm" title={c.activa ? 'Reproducir el flujo de video' : 'Habilite la cámara para reproducirla'} disabled={!c.activa} onClick={() => setReproduciendo(c)}>
                          <Play size={14} /> Play</button>
                        <button className="btn btn-secondary btn-sm" title={c.activa ? 'Dibujar el área donde se buscan placas' : 'Habilite la cámara para dibujar su área'} disabled={!c.activa} onClick={() => setArea(c)}>
                          <Crop size={14} /> Área</button>
                        <button className="btn btn-ghost btn-sm btn-icono" title="Editar" aria-label="Editar" onClick={() => setEditando(c)}><Edit3 size={15} /></button>
                        <button className="btn btn-ghost btn-sm btn-icono" title={c.detecciones ? 'Tiene historial: deshabilítela en su lugar' : 'Eliminar'} aria-label="Eliminar"
                          disabled={Boolean(c.detecciones)} onClick={() => setEliminando(c)}><Trash2 size={15} color={c.detecciones ? undefined : 'var(--alerta)'} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </Tarjeta>
      </div>
      {editando && <FormularioCamara camara={editando === 'nueva' ? undefined : editando} onCerrar={() => setEditando(null)}
        onGuardada={c => { reemplazar(c); setEditando(null); notificar('exito', 'Cámara guardada', 'Se verificará su conectividad en segundos.'); }} />}
      {diagnostico && (
        <Modal titulo={`Diagnóstico · ${diagnostico.camara.nombre}`} subtitulo={diagnostico.camara.ubicacion} onCerrar={() => setDiagnostico(null)} tamano="estrecho"
          pie={<>
            <button className="btn btn-secondary" onClick={() => setDiagnostico(null)}>Cerrar</button>
            {diagnostico.resultado.rtsp.en_linea && <button className="btn btn-navy" onClick={() => { setReproduciendo(diagnostico.camara); setDiagnostico(null); }}><Play size={14} /> Reproducir</button>}
          </>}>
          <PanelDiagnostico resultado={diagnostico.resultado} />
        </Modal>
      )}
      {area && <EditorRoi camara={area} onCerrar={() => setArea(null)}
        onGuardada={c => { reemplazar(c); setArea(null); notificar('exito', c.roi ? 'Área de interés guardada' : 'Se analizará el cuadro completo', 'El motor la aplica de inmediato si procesa esta cámara.'); }} />}
      {reproduciendo && <ReproductorPrueba titulo={reproduciendo.nombre} camaraId={reproduciendo.id} onCerrar={() => setReproduciendo(null)} />}
      {eliminando && (
        <Confirmar titulo="Eliminar cámara" peligro textoBoton="Eliminar" mensaje={<>Se eliminará <b>{eliminando.nombre}</b>. Solo es posible porque no tiene detecciones registradas.</>}
          onConfirmar={async () => {
            try { await api.delete(`/camaras/${eliminando.id}`); } catch (e) { throw new Error(mensajeError(e)); }
            setDatos(l => l && l.filter(x => x.id !== eliminando.id));
            notificar('exito', 'Cámara eliminada');
          }} onCerrar={() => setEliminando(null)} />
      )}
    </div>
  );
};

export default Camaras;
