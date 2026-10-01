import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Clock, Edit3, FileCheck2, FileSearch, MinusCircle, ShieldAlert, ShieldCheck, Trash2, UserSearch, XCircle } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta } from '../lib/hooks';
import type { Deteccion, DeteccionDetalle, EvidenciaLectura } from '../lib/tipos';
import { ESTADOS, fechaHora, NIVELES_ALERTA, numero, porcentaje, relativo } from '../lib/formato';
import { Aviso, Cargando, InsigniaEstado, Modal, Placa, Tarjeta, Vacio } from '../components/ui';
import { describirVehiculo, ImagenEvidencia, ValidarModal } from '../components/deteccion';
import { VisorZoom } from '../components/ZoomDual';
import { useNotificar } from '../components/Notificaciones';
import { FormularioLista } from '../components/FormularioLista';
import { EliminarUno } from '../components/EliminarDetecciones';
import { FormularioSolicitud } from '../components/FormularioSolicitud';

const DECISION: Record<string, string> = { ...Object.fromEntries(Object.entries(ESTADOS).map(([k, v]) => [k, v.etiqueta])), manual: 'Registro manual' };

const ConsultaPropietario: React.FC<{ d: DeteccionDetalle; onCerrar: () => void }> = ({ d, onCerrar }) => {
  const [motivo, setMotivo] = useState(d.estado_validacion === 'alerta' ? 'Verificación de vehículo con alerta en el acceso' : '');
  const [resultado, setResultado] = useState<{ tipo: 'exito' | 'error' | 'advertencia'; texto: string } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const consultar = async () => {
    setEnviando(true);
    try {
      const r = await api.post('/propietario/consulta', { placa: d.placa, motivo: motivo.trim(), deteccion_id: d.id });
      setResultado({ tipo: 'exito', texto: `${r.data.nombre}${r.data.identificacion ? ` (${r.data.identificacion})` : ''} · fuente: ${r.data.fuente}` });
    } catch (e: any) {
      setResultado({ tipo: e?.response?.status === 503 ? 'advertencia' : 'error', texto: mensajeError(e) });
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Modal titulo="Consulta del propietario" subtitulo={`Placa ${d.placa}`} onCerrar={onCerrar} tamano="estrecho"
      pie={<><button className="btn btn-secondary" onClick={onCerrar}>Cerrar</button>
        <button className="btn btn-navy" disabled={motivo.trim().length < 10 || enviando} onClick={consultar}>Consultar</button></>}>
      <div className="pila" style={{ gap: 12 }}>
        <Aviso tipo="info">Solo mediante el servicio web oficial (convenio DINARDAP / ANT). Cada consulta, con su motivo, queda registrada.</Aviso>
        <div className="campo">
          <label htmlFor="prop-motivo">Motivo de la consulta* (mínimo 10 caracteres)</label>
          <textarea id="prop-motivo" className="textarea" value={motivo} onChange={e => setMotivo(e.target.value)} maxLength={255} />
        </div>
        {resultado && <Aviso tipo={resultado.tipo}>{resultado.texto}</Aviso>}
      </div>
    </Modal>
  );
};

/**
 * Evidencias independientes con que el motor decide si una lectura es válida (y por tanto
 * si una placa del padrón puede autorizarse sola). Ver services/anpr/app/core/verificacion_placa.py.
 */
const ChecklistValidez: React.FC<{ valida: boolean | null; ev: EvidenciaLectura | null }> = ({ valida, ev }) => {
  if (!ev) {
    return <p className="texto-secundario">El motor no informó evidencias para esta lectura (registro anterior a la verificación por evidencias o paso manual).</p>;
  }
  const filaOk = !ev.motivos.some(m => m.startsWith('fila'));
  const consenso = ev.lecturas >= 2 || ev.verificador_coincide;
  const items: { ok: boolean | null; titulo: string; detalle: string }[] = [
    { ok: ev.formato, titulo: 'Formato oficial ANT', detalle: ev.formato ? 'La lectura corresponde a un formato de placa vigente.' : 'La lectura no corresponde a un formato de placa ANT.' },
    { ok: ev.dentro_cuadro, titulo: 'Placa completa en el cuadro', detalle: ev.dentro_cuadro ? 'La placa no está cortada por el borde de la imagen.' : 'La placa toca el borde del cuadro: la lectura puede estar truncada.' },
    { ok: filaOk, titulo: 'Fila de caracteres (análisis estilo OpenALPR)',
      detalle: `${ev.caracteres} caracteres alineados de altura similar${ev.angulo !== undefined ? ` · inclinación ${ev.angulo}°` : ''}${ev.bordes_hallados !== undefined ? ` · ${ev.bordes_hallados} de 4 bordes de la placa hallados` : ''}${!filaOk ? '' : ev.caracteres < 5 ? ' · sustituida por consenso fuerte' : ''}.` },
    { ok: ev.lecturas >= 2 ? true : ev.verificador_coincide ? null : false, titulo: 'Consenso de varios cuadros',
      detalle: `${ev.lecturas} ${ev.lecturas === 1 ? 'lectura' : 'lecturas'} idénticas en cuadros distintos del mismo vehículo.` },
    { ok: ev.verificador_coincide ? true : ev.lecturas >= 2 ? null : false, titulo: 'Segundo OCR independiente (PP-OCRv6)',
      detalle: ev.lectura_verificador ? (ev.verificador_coincide ? `Coincide: ${ev.lectura_verificador}.` : `Leyó ${ev.lectura_verificador}.`) : 'Sin lectura del verificador.' },
  ];
  return (
    <div className="pila" style={{ gap: 10 }}>
      <Aviso tipo={valida ? 'exito' : 'advertencia'}>
        {valida
          ? <><b>Lectura válida:</b> cumple todas las evidencias; si la placa está en el padrón se autoriza sin intervención (según el criterio configurado).</>
          : <><b>Lectura no confirmada:</b> {ev.motivos.join('; ')}. Requiere confirmación del personal.</>}
      </Aviso>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {items.map(i => (
          <li key={i.titulo} className="fila" style={{ alignItems: 'flex-start', gap: 10 }}>
            {i.ok === true ? <CheckCircle2 size={18} color="var(--autorizado)" style={{ flexShrink: 0, marginTop: 1 }} />
              : i.ok === false ? <XCircle size={18} color="var(--alerta)" style={{ flexShrink: 0, marginTop: 1 }} />
              : <MinusCircle size={18} color="var(--text-4)" style={{ flexShrink: 0, marginTop: 1 }} />}
            <div><strong style={{ fontSize: 13.5, color: 'var(--text)' }}>{i.titulo}</strong>
              <p className="texto-secundario" style={{ marginTop: 1 }}>{i.detalle}</p></div>
          </li>
        ))}
      </ul>
      <p className="texto-secundario" style={{ fontSize: 12 }}>
        La confirmación exige consenso de varios cuadros <i>o</i> coincidencia del segundo OCR{consenso ? ' (cumplida)' : ''}; el ícono gris indica que esa evidencia no fue necesaria.
      </p>
    </div>
  );
};

const DetalleDeteccion: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const notificar = useNotificar();
  const { puede } = useAuth();
  const { datos: d, cargando, error, recargar } = useConsulta<DeteccionDetalle>(() => api.get(`/detecciones/${id}`).then(r => r.data), [id]);
  const [validar, setValidar] = useState(false);
  const [excepcion, setExcepcion] = useState(false);
  const [solicitar, setSolicitar] = useState(false);
  const [eliminar, setEliminar] = useState(false);
  const [propietario, setPropietario] = useState(false);
  const [lista, setLista] = useState<'autorizados' | 'alertas' | null>(null);
  const [zoom, setZoom] = useState(false);

  useEvento<Deteccion>('deteccion:actualizada', x => { if (String(x.id) === id) recargar(true); });
  useEvento<{ id: number }>('deteccion:eliminada', x => { if (String(x.id) === id) navigate('/detecciones', { replace: true }); });

  if (cargando && !d) return <div className="pagina"><Cargando alto={400} /></div>;
  if (error || !d) {
    return <div className="pagina"><Tarjeta><Vacio titulo="No se encontró el ingreso" texto={error ?? undefined} icono={<FileSearch size={22} />}
      accion={<Link to="/detecciones" className="btn btn-secondary">Volver al registro</Link>} /></Tarjeta></div>;
  }

  const la = d.lectura_automatica;
  const corregida = d.validado_manualmente && la.placa && d.placa_validada && la.placa.replace(/-/g, '') !== d.placa_validada.replace(/-/g, '');
  const procesando = d.estado_procesamiento === 'pendiente_ocr';

  return (
    <div className="pagina">
      <div className="fila" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <button className="btn btn-ghost" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/detecciones'))}><ArrowLeft size={16} /> Volver</button>
        <div className="fila">
          {!procesando && <button className="btn btn-navy" onClick={() => setValidar(true)}><Edit3 size={15} /> {d.validado_manualmente ? 'Corregir placa' : 'Validar placa'}</button>}
          {puede('accesos:excepcion') && d.placa && d.restriccion_acceso && d.estado_validacion !== 'autorizado' && (
            <button className="btn btn-exito" onClick={() => setExcepcion(true)}><Clock size={15} /> Autorizar por excepción</button>
          )}
          {puede('padron:gestionar') && d.placa && !d.autorizado && !d.alerta && (
            <button className="btn btn-secondary" onClick={() => setLista('autorizados')}><ShieldCheck size={15} /> Autorizar vehículo</button>
          )}
          {!puede('padron:gestionar') && puede('solicitudes:crear') && d.placa && !d.alerta && d.estado_validacion !== 'autorizado' && (
            <button className="btn btn-secondary" onClick={() => setSolicitar(true)}><FileCheck2 size={15} /> Solicitar autorización</button>
          )}
          {puede('alertas:gestionar') && d.placa && !d.alerta && (
            <button className="btn btn-secondary" onClick={() => setLista('alertas')}><ShieldAlert size={15} /> Agregar alerta</button>
          )}
          {puede('propietario:consultar') && d.placa && <button className="btn btn-secondary" onClick={() => setPropietario(true)}><UserSearch size={15} /> Propietario</button>}
          {puede('detecciones:eliminar') && <button className="btn btn-danger" onClick={() => setEliminar(true)}><Trash2 size={15} /> Eliminar</button>}
        </div>
      </div>

      {d.estado_validacion === 'alerta' && d.alerta && (
        <Aviso tipo="error" style={{ marginBottom: 16 }}>
          <b>Vehículo en la lista de alertas</b> · {d.alerta.motivo} · nivel {NIVELES_ALERTA[d.alerta.nivel]?.etiqueta ?? d.alerta.nivel}
        </Aviso>
      )}
      {d.motivo_revision && <Aviso tipo="advertencia" style={{ marginBottom: 16 }}>{d.motivo_revision}</Aviso>}
      {d.verificacion_vehiculo === 'no_coincide' && !d.motivo_revision && (
        <Aviso tipo="advertencia" style={{ marginBottom: 16 }}>El vehículo observado no coincide con el registrado para esta placa: {d.verificacion_detalle}. Puede ser una lectura errónea o una placa clonada.</Aviso>
      )}

      <div className="grid-principal">
        <div className="pila">
          <Tarjeta titulo="Evidencia fotográfica">
            <div className="grid-2">
              <div>
                <span className="etiqueta-campo">Vehículo</span>
                <div style={{ marginTop: 6 }}><ImagenEvidencia ruta={d.imagen_vehiculo} alt="Vehículo" alto={260} onClick={() => setZoom(true)} /></div>
              </div>
              <div>
                <span className="etiqueta-campo">Placa</span>
                <div style={{ marginTop: 6 }}><ImagenEvidencia ruta={d.imagen_placa} alt="Placa" alto={260} ajuste="contain" fondoOscuro onClick={() => setZoom(true)} /></div>
              </div>
            </div>
          </Tarjeta>

          <Tarjeta titulo="Lectura automática y verificación" subtitulo="Datos conservados para la evaluación del sistema">
            <dl className="definiciones">
              <dt>Lectura OCR</dt><dd>{la.placa ? <span className="mono">{la.placa}</span> : 'Sin lectura'}{la.confianza !== null && ` · confianza ${porcentaje(la.confianza)}`}</dd>
              <dt>Segunda lectura</dt><dd>{la.verificador ? <span className="mono">{la.verificador}</span> : '—'}</dd>
              <dt>Decisión automática</dt><dd>{la.decision ? DECISION[la.decision] ?? la.decision : '—'}</dd>
              <dt>Resultado final</dt><dd><InsigniaEstado estado={d.estado_validacion} procesando={procesando} />{corregida && <span className="texto-secundario"> · lectura corregida por el personal</span>}</dd>
              <dt>Confianza de detección</dt><dd>{porcentaje(d.confianza_deteccion)}</dd>
              <dt>Latencia de procesamiento</dt><dd>{la.latencia_ms !== null ? `${numero(la.latencia_ms)} ms` : '—'}</dd>
              <dt>Modelos</dt><dd>{[la.modelo_detector, la.modelo_ocr].filter(Boolean).join(' · ') || '—'}</dd>
              <dt>Condiciones de captura</dt><dd>{[
                d.captura.luminancia_media !== null && `luminancia ${Math.round(d.captura.luminancia_media)}`,
                d.captura.ancho_placa_px !== null && `placa de ${d.captura.ancho_placa_px} px`,
                d.captura.distancia_estimada_m !== null && `~${d.captura.distancia_estimada_m.toFixed(1)} m`,
                d.captura.nitidez !== null && `nitidez ${Math.round(d.captura.nitidez)}`,
              ].filter(Boolean).join(' · ') || '—'}</dd>
            </dl>
          </Tarjeta>

          {d.estado_procesamiento === 'procesado' && !d.validado_manualmente || la.evidencia ? (
            <Tarjeta titulo="Validez de la lectura" subtitulo="Evidencias independientes evaluadas por el motor ANPR">
              <ChecklistValidez valida={la.valida} ev={la.evidencia} />
            </Tarjeta>
          ) : null}

          <Tarjeta titulo={`Pasos anteriores${d.placa ? ` de ${d.placa}` : ''}`} sinPadding>
            {d.pasos_anteriores.length === 0 ? <Vacio titulo="Sin pasos anteriores" texto={d.placa ? 'Es el primer registro de esta placa.' : 'Sin placa para relacionar.'} /> : (
              <div className="tabla-contenedor"><table className="tabla"><thead><tr><th>Fecha</th><th>Estado</th><th>Cámara</th></tr></thead><tbody>
                {d.pasos_anteriores.map(p => (
                  <tr key={p.id} className="clic" onClick={() => navigate(`/detecciones/${p.id}`)}>
                    <td>{fechaHora(p.fecha_hora_ingreso)}</td><td><InsigniaEstado estado={p.estado_validacion} /></td><td>{p.camara?.nombre ?? '—'}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </Tarjeta>
        </div>

        <div className="pila">
          <Tarjeta>
            <div className="pila" style={{ gap: 12, alignItems: 'flex-start' }}>
              <Placa valor={d.placa} grande />
              <InsigniaEstado estado={d.estado_validacion} procesando={procesando} />
              <dl className="definiciones" style={{ width: '100%' }}>
                <dt>Ingreso</dt><dd>{fechaHora(d.fecha_hora_ingreso)} <span className="texto-secundario">({relativo(d.fecha_hora_ingreso)})</span></dd>
                <dt>Acceso</dt><dd>{d.camara ? `${d.camara.nombre} · ${d.camara.ubicacion}` : d.fuente === 'manual' ? 'Registro manual' : '—'}</dd>
                <dt>Tipo de vehículo</dt><dd>{d.tipo_vehiculo ?? '—'}</dd>
                <dt>Vehículo observado</dt><dd>{describirVehiculo(d)}</dd>
                {d.autorizado && <><dt>Titular (padrón)</dt><dd>{d.autorizado.propietario}{d.autorizado.departamento && <span className="secundario texto-secundario"> · {d.autorizado.departamento}</span>}</dd></>}
                {d.restriccion_acceso && <><dt>Restricción del permiso</dt><dd><span className="insignia no_reconocido"><Clock size={12} /> {d.restriccion_acceso === 'fuera_horario' ? 'Fuera de horario' : d.restriccion_acceso === 'no_iniciada' ? 'Aún no vigente' : 'Vencido'}</span></dd></>}
                <dt>Validación</dt><dd>{d.validacion ? `${d.validacion.usuario?.nombre ?? 'Personal'} · ${fechaHora(d.validacion.fecha)}` : 'Automática'}</dd>
                <dt>Registro</dt><dd className="mono" style={{ fontSize: 12 }}>#{d.id}{d.tracking_id && d.tracking_id > 0 ? ` · track ${d.tracking_id}` : ''}</dd>
              </dl>
            </div>
          </Tarjeta>

          <Tarjeta titulo="Trazabilidad">
            <ul className="linea-tiempo">
              {d.auditoria.map((a, i) => (
                <li key={i}><div><strong>{a.accion.replace(/_/g, ' ').toLowerCase()}</strong><span>{a.usuario_email ?? 'sistema'} · {fechaHora(a.fecha)}</span>{a.detalle && <span>{a.detalle}</span>}</div></li>
              ))}
              {d.fecha_hora_procesamiento && <li><div><strong>lectura automática</strong><span>Motor ANPR · {fechaHora(d.fecha_hora_procesamiento)}</span></div></li>}
              <li><div><strong>captura del vehículo</strong><span>{d.fuente === 'manual' ? 'Registro manual' : `Cámara · ${fechaHora(d.fecha_hora_ingreso)}`}</span></div></li>
            </ul>
          </Tarjeta>
        </div>
      </div>

      {validar && <ValidarModal d={d} onCerrar={() => setValidar(false)} onValidada={() => recargar(true)} />}
      {excepcion && <ValidarModal d={d} excepcion onCerrar={() => setExcepcion(false)} onValidada={() => recargar(true)} />}
      {solicitar && d.placa && (
        <FormularioSolicitud inicial={{ placa: d.placa, marca: d.vehiculo.marca, modelo: d.vehiculo.modelo, color: d.vehiculo.color, tipo_vehiculo: d.tipo_vehiculo, deteccion_id: d.id }}
          onCerrar={() => setSolicitar(false)} onEnviada={s => { setSolicitar(false); notificar('exito', `Solicitud #${s.id} enviada`, 'El gestor de accesos fue notificado.'); }} />
      )}
      {propietario && <ConsultaPropietario d={d} onCerrar={() => setPropietario(false)} />}
      {lista && d.placa && <FormularioLista tipo={lista} inicial={{ placa: d.placa, marca: d.vehiculo.marca, modelo: d.vehiculo.modelo, color: d.vehiculo.color, tipo_vehiculo: d.tipo_vehiculo }}
        onCerrar={() => setLista(null)} onGuardado={() => { setLista(null); notificar('exito', lista === 'autorizados' ? 'Vehículo autorizado' : 'Alerta registrada', 'Aplica a los próximos ingresos de la placa.'); }} />}
      {eliminar && <EliminarUno d={d} onCerrar={() => setEliminar(false)} onEliminada={() => navigate('/detecciones', { replace: true })} />}
      {zoom && <VisorZoom d={d} onCerrar={() => setZoom(false)} />}
    </div>
  );
};

export default DetalleDeteccion;
