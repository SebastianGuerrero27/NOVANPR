import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ImageOff, Loader2, Trash2 } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import type { Camara, Deteccion } from '../lib/tipos';
import { ESTADOS, fechaHora, hora, porcentaje, urlMedia } from '../lib/formato';
import { Aviso, InsigniaEstado, Modal, Placa } from './ui';
import { useNotificar } from './Notificaciones';
import { VisorZoom } from './ZoomDual';

export const TIPOS_VEHICULO = ['Automóvil', 'Camioneta', 'SUV', 'Motocicleta', 'Camión', 'Bus', 'Furgoneta'];

/** Imagen de evidencia con carga diferida y marcador si no existe. */
export const ImagenEvidencia: React.FC<{ ruta: string | null; alt: string; alto?: number | string; ajuste?: 'cover' | 'contain'; onClick?: () => void; fondoOscuro?: boolean }> =
  ({ ruta, alt, alto = 120, ajuste = 'cover', onClick, fondoOscuro }) => {
    const [error, setError] = useState(false);
    const src = urlMedia(ruta);
    useEffect(() => setError(false), [ruta]);
    const estilo: React.CSSProperties = {
      width: '100%', height: alto, borderRadius: 8, background: fondoOscuro ? '#0b1220' : 'var(--surface-3)', overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-4)', cursor: onClick && src && !error ? 'zoom-in' : undefined,
    };
    if (!src || error) return <div style={estilo}><ImageOff size={20} /></div>;
    return (
      <div style={estilo} onClick={onClick}>
        <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setError(true)} style={{ width: '100%', height: '100%', objectFit: ajuste }} />
      </div>
    );
  };

export function describirVehiculo(d: Pick<Deteccion, 'vehiculo' | 'tipo_vehiculo'>): string {
  const v = d.vehiculo;
  const nombre = [v.marca, v.modelo].filter(Boolean).join(' ');
  return [nombre, v.color].filter(Boolean).join(' · ') || d.tipo_vehiculo || '—';
}

/** Tarjeta compacta de un paso vehicular (feed de monitoreo y listas cortas). */
/** Tarjeta de un paso vehicular en el feed (verde si autorizado, roja si alerta). */
export const TarjetaDeteccion: React.FC<{ d: Deteccion; onValidar?: (d: Deteccion) => void; onEliminar?: (d: Deteccion) => void; resaltada?: boolean }> = ({ d, onValidar, onEliminar, resaltada }) => {
  const navigate = useNavigate();
  const [zoom, setZoom] = useState(false);
  const procesando = d.estado_procesamiento === 'pendiente_ocr';
  const autorizado = !procesando && d.estado_validacion === 'autorizado';
  const alerta = !procesando && d.estado_validacion === 'alerta';
  const color = procesando ? 'var(--pendiente)' : ESTADOS[d.estado_validacion]?.color ?? 'var(--border)';
  const fondo = resaltada ? '#fffbeb' : autorizado ? '#f3fcf6' : alerta ? '#fef5f5' : 'var(--surface)';
  const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)} %`);
  return (
    <article className="animate-fade-in"
      onClick={() => navigate(`/detecciones/${d.id}`)}
      style={{
        display: 'grid', gridTemplateColumns: '96px 1fr', gap: 12, padding: 10, borderRadius: 10, cursor: 'pointer',
        border: `1px solid ${autorizado ? 'var(--autorizado-border)' : alerta ? 'var(--alerta-border)' : 'var(--border)'}`,
        borderLeft: `4px solid ${color}`, background: fondo, transition: 'background 0.6s',
      }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="miniatura-zoom" title="Clic para ver la fotografía y la placa con zoom" onClick={e => { e.stopPropagation(); if (d.imagen_placa || d.imagen_vehiculo) setZoom(true); }}>
          <ImagenEvidencia ruta={d.imagen_placa || d.imagen_vehiculo} alt={`Placa ${d.placa ?? 'sin lectura'}`} alto={60} ajuste="contain" fondoOscuro />
        </div>
        <div className="fila" style={{ justifyContent: 'space-around', fontSize: 9.5, color: 'var(--text-3)', gap: 4 }}>
          {pct(d.confianza_deteccion) && <span title="Confianza de la detección">Det {pct(d.confianza_deteccion)}</span>}
          {procesando ? <span>OCR ⏳</span> : pct(d.confianza_ocr) && <span style={{ color: 'var(--pendiente)', fontWeight: 700 }} title="Confianza de la lectura">OCR {pct(d.confianza_ocr)}</span>}
        </div>
      </div>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div className="fila" style={{ justifyContent: 'space-between', gap: 6 }}>
          {procesando && !d.placa ? <span className="placa vacia">Leyendo…</span> : <Placa valor={d.placa} />}
          <span className="fila nowrap" style={{ gap: 2 }}>
            <span className="texto-secundario" style={{ fontSize: 11.5 }}>{hora(d.fecha_hora_ingreso)}</span>
            {onEliminar && (
              <button className="btn btn-ghost btn-sm btn-icono" style={{ width: 24, height: 24 }} title="Eliminar registro" aria-label="Eliminar registro"
                onClick={e => { e.stopPropagation(); onEliminar(d); }}><Trash2 size={13} color="var(--alerta)" /></button>
            )}
          </span>
        </div>
        <div className="fila" style={{ gap: 6, justifyContent: 'space-between' }}>
          <InsigniaEstado estado={d.estado_validacion} procesando={procesando} corta solido={autorizado || alerta} />
          {!procesando && d.estado_validacion === 'pendiente_revision' && onValidar && (
            <button className="btn btn-sm btn-secondary" onClick={e => { e.stopPropagation(); onValidar(d); }}>Validar</button>
          )}
        </div>
        {autorizado && d.autorizado && (
          <div className="truncar" style={{ fontSize: 12, color: 'var(--autorizado)', fontWeight: 600 }} title={d.autorizado.propietario}>
            ✓ {d.autorizado.propietario}{d.autorizado.departamento ? ` (${d.autorizado.departamento})` : ''}
          </div>
        )}
        {!procesando && d.motivo_revision && (
          <div className="truncar" style={{ fontSize: 11.5, color: 'var(--no-registrado)', fontWeight: 600 }} title={d.motivo_revision}>
            ⓘ En padrón{d.autorizado ? ` (${d.autorizado.propietario})` : ''} · confirme la placa
          </div>
        )}
        {alerta && (
          <div className="truncar" style={{ fontSize: 12, color: 'var(--alerta)', fontWeight: 600, background: 'var(--alerta-bg)', padding: '2px 6px', borderRadius: 4 }}>
            ⚠ {d.alerta?.motivo ?? 'Coincidencia con la lista de alertas'}
          </div>
        )}
        <div className="texto-secundario truncar" style={{ fontSize: 11.5 }}>
          {[d.camara?.nombre ?? (d.fuente === 'manual' ? 'Registro manual' : null), describirVehiculo(d)].filter(x => x && x !== '—').join(' · ') || 'Sin datos adicionales'}
        </div>
      </div>
      {zoom && <div onClick={e => e.stopPropagation()}><VisorZoom d={d} onCerrar={() => setZoom(false)} /></div>}
    </article>
  );
};

/** Validación / corrección manual de un paso vehicular por el personal. */
export const ValidarModal: React.FC<{ d: Deteccion; onCerrar: () => void; onValidada?: (d: Deteccion) => void }> = ({ d, onCerrar, onValidada }) => {
  const notificar = useNotificar();
  const [placa, setPlaca] = useState(d.placa_validada || d.placa_reconocida || '');
  const [tipo, setTipo] = useState(d.tipo_vehiculo && TIPOS_VEHICULO.includes(d.tipo_vehiculo) ? d.tipo_vehiculo : '');
  const [observacion, setObservacion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const valida = limpia.length >= 4 && limpia.length <= 10;
  const [zoom, setZoom] = useState(false);

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post(`/detecciones/validar/${d.id}`, { placa_validada: limpia, tipo_vehiculo: tipo || undefined, observacion: observacion.trim() || undefined });
      const det: Deteccion = r.data.deteccion;
      notificar(det.estado_validacion === 'alerta' ? 'error' : 'exito', `Ingreso validado: ${det.placa}`, ESTADOS[det.estado_validacion].etiqueta);
      onValidada?.(det);
      onCerrar();
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo="Validar ingreso" subtitulo={`${fechaHora(d.fecha_hora_ingreso)}${d.camara ? ` · ${d.camara.nombre}` : ''}`} onCerrar={onCerrar} bloquear={enviando}
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-navy" onClick={guardar} disabled={!valida || enviando}>{enviando && <Loader2 size={14} className="girar" />} Confirmar placa</button>
      </>}>
      <div className="pila">
        <div className="grid-2" style={{ gap: 10 }}>
          <div><span className="etiqueta-campo">Placa (recorte)</span><div style={{ marginTop: 6 }}>
            <ImagenEvidencia ruta={d.imagen_placa} alt="Recorte de placa" alto={110} ajuste="contain" fondoOscuro onClick={() => setZoom(true)} /></div></div>
          <div><span className="etiqueta-campo">Vehículo</span><div style={{ marginTop: 6 }}>
            <ImagenEvidencia ruta={d.imagen_vehiculo} alt="Vehículo" alto={110} onClick={() => setZoom(true)} /></div></div>
        </div>
        {d.motivo_revision && <Aviso tipo="advertencia">{d.motivo_revision}</Aviso>}
        <div className="texto-secundario">
          Lectura automática: <b style={{ color: 'var(--text)' }}>{d.placa_reconocida || 'sin lectura'}</b>
          {d.confianza_ocr !== null && <> · confianza {porcentaje(d.confianza_ocr)}</>}
        </div>
        <div className="form-grid">
          <div className="campo">
            <label htmlFor="val-placa">Placa confirmada*</label>
            <input id="val-placa" className="input placa-input" value={placa} maxLength={10} autoFocus
              onChange={e => setPlaca(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter' && valida && !enviando) guardar(); }} placeholder="ABC1234" />
            <span className="ayuda">Letras y números, sin guion.</span>
          </div>
          <div className="campo">
            <label htmlFor="val-tipo">Tipo de vehículo</label>
            <select id="val-tipo" className="select" value={tipo} onChange={e => setTipo(e.target.value)}>
              <option value="">Según registro / formato de placa</option>
              {TIPOS_VEHICULO.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="campo completo">
            <label htmlFor="val-obs">Observación (opcional)</label>
            <input id="val-obs" className="input" value={observacion} maxLength={300} onChange={e => setObservacion(e.target.value)} placeholder="Ej.: placa sucia, lectura corregida por el operador" />
          </div>
        </div>
        <Aviso tipo="info">Al confirmar, la placa se vuelve a cruzar con el padrón de autorizados y la lista de alertas. La corrección queda registrada con su usuario.</Aviso>
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
      {zoom && <VisorZoom d={d} onCerrar={() => setZoom(false)} />}
    </Modal>
  );
};

/** Registro manual de un paso (cámara sin lectura, visita, etc.). */
export const RegistroManualModal: React.FC<{ onCerrar: () => void; placaInicial?: string }> = ({ onCerrar, placaInicial = '' }) => {
  const notificar = useNotificar();
  const [placa, setPlaca] = useState(placaInicial);
  const [motivo, setMotivo] = useState('');
  const [tipo, setTipo] = useState('');
  const [camara, setCamara] = useState('');
  const [camaras, setCamaras] = useState<Camara[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => { api.get('/camaras').then(r => setCamaras(r.data)).catch(() => undefined); }, []);
  const limpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const valido = limpia.length >= 4 && limpia.length <= 10 && motivo.trim().length >= 5;

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post('/detecciones/registro-manual', { placa: limpia, motivo: motivo.trim(), tipo_vehiculo: tipo || undefined, camara_id: camara ? Number(camara) : undefined });
      const d: Deteccion = r.data.deteccion;
      notificar(d.estado_validacion === 'alerta' ? 'error' : 'exito', `Ingreso manual registrado: ${d.placa}`, ESTADOS[d.estado_validacion].etiqueta);
      onCerrar();
      if (d.estado_validacion === 'alerta') navigate(`/detecciones/${d.id}`);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo="Registrar ingreso manual" subtitulo="Para vehículos que la cámara no registró o no pudo leer" onCerrar={onCerrar} bloquear={enviando}
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-navy" onClick={guardar} disabled={!valido || enviando}>{enviando && <Loader2 size={14} className="girar" />} Registrar ingreso</button>
      </>}>
      <div className="form-grid">
        <div className="campo">
          <label htmlFor="man-placa">Placa*</label>
          <input id="man-placa" className="input placa-input" value={placa} maxLength={10} autoFocus onChange={e => setPlaca(e.target.value.toUpperCase())} placeholder="ABC1234" />
        </div>
        <div className="campo">
          <label htmlFor="man-tipo">Tipo de vehículo</label>
          <select id="man-tipo" className="select" value={tipo} onChange={e => setTipo(e.target.value)}>
            <option value="">Según registro / formato de placa</option>
            {TIPOS_VEHICULO.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="campo completo">
          <label htmlFor="man-camara">Acceso</label>
          <select id="man-camara" className="select" value={camara} onChange={e => setCamara(e.target.value)}>
            <option value="">Sin cámara asociada</option>
            {camaras.map(c => <option key={c.id} value={c.id}>{c.nombre} · {c.ubicacion}</option>)}
          </select>
        </div>
        <div className="campo completo">
          <label htmlFor="man-motivo">Motivo del registro manual*</label>
          <textarea id="man-motivo" className="textarea" value={motivo} maxLength={300} onChange={e => setMotivo(e.target.value)}
            placeholder="Ej.: cámara fuera de servicio, placa ilegible por suciedad, ingreso de visita" />
        </div>
        <div className="completo"><Aviso tipo="info">El ingreso se cruza con las listas como cualquier lectura. No modifica el padrón de autorizados: para autorizar un vehículo use la pantalla de listas.</Aviso></div>
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
    </Modal>
  );
};

export { InsigniaEstado };
