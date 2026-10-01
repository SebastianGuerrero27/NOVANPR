import React, { useState } from 'react';
import { AlertTriangle, Loader2, Send, ShieldCheck } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import type { Franja, SolicitudAcceso } from '../lib/tipos';
import { CATEGORIAS_PERMISO, fechaHora, fechaIsoLocal } from '../lib/formato';
import { Aviso, Modal, Placa } from './ui';
import { EditorHorario, horarioValido } from './EditorHorario';
import { COLORES, MARCAS } from './FormularioLista';
import { TIPOS_VEHICULO } from './deteccion';

export interface DatosIniciales {
  placa?: string | null;
  marca?: string | null;
  modelo?: string | null;
  color?: string | null;
  tipo_vehiculo?: string | null;
  deteccion_id?: number;
}

/**
 * Solicitud de autorización de una placa (operador, supervisor…): el gestor de accesos la
 * recibe como notificación y decide. Se abre desde el aviso de vehículo no autorizado, el
 * detalle de un ingreso o la pantalla de solicitudes.
 */
export const FormularioSolicitud: React.FC<{ inicial?: DatosIniciales; onCerrar: () => void; onEnviada: (s: SolicitudAcceso) => void }> = ({ inicial, onCerrar, onEnviada }) => {
  const [f, setF] = useState({
    placa: inicial?.placa ?? '', propietario: '', departamento: '', categoria: 'VISITANTE', motivo: '',
    tipo_vehiculo: inicial?.tipo_vehiculo ?? '', marca: inicial?.marca ?? '', modelo: inicial?.modelo ?? '', color: inicial?.color ?? '',
    fecha_inicio: '', fecha_fin: fechaIsoLocal(),
  });
  const [horario, setHorario] = useState<Franja[] | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const placa = f.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const valido = placa.length >= 4 && placa.length <= 10 && f.propietario.trim().length >= 3 && f.motivo.trim().length >= 5
    && horarioValido(horario) && (!f.fecha_inicio || !f.fecha_fin || f.fecha_inicio <= f.fecha_fin);

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post('/solicitudes-acceso', {
        ...f, placa, horario, fecha_inicio: f.fecha_inicio || null, fecha_fin: f.fecha_fin || null, deteccion_id: inicial?.deteccion_id,
      });
      onEnviada(r.data.solicitud);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo="Solicitar autorización de ingreso" subtitulo="El gestor de accesos recibirá la solicitud de inmediato y decidirá si concede el permiso."
      onCerrar={onCerrar} bloquear={enviando} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-navy" onClick={enviar} disabled={!valido || enviando}>{enviando ? <Loader2 size={14} className="girar" /> : <Send size={14} />} Enviar solicitud</button>
      </>}>
      <div className="form-grid">
        <div className="campo">
          <label htmlFor="s-placa">Placa*</label>
          <input id="s-placa" className="input placa-input" value={f.placa} maxLength={10} autoFocus={!inicial?.placa}
            onChange={e => setF(x => ({ ...x, placa: e.target.value.toUpperCase() }))} placeholder="ABC1234" />
        </div>
        <div className="campo">
          <label htmlFor="s-cat">Categoría</label>
          <select id="s-cat" className="select" value={f.categoria} onChange={campo('categoria')}>
            {Object.entries(CATEGORIAS_PERMISO).map(([v, e]) => <option key={v} value={v}>{e}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor="s-prop">Conductor o responsable*</label>
          <input id="s-prop" className="input" value={f.propietario} onChange={campo('propietario')} maxLength={150} autoFocus={!!inicial?.placa} placeholder="Nombres y apellidos / empresa" />
        </div>
        <div className="campo">
          <label htmlFor="s-dep">Unidad que visita</label>
          <input id="s-dep" className="input" value={f.departamento} onChange={campo('departamento')} maxLength={100} placeholder="Ej.: Dirección Zonal" />
        </div>
        <div className="campo completo">
          <label htmlFor="s-motivo">Motivo del ingreso*</label>
          <textarea id="s-motivo" className="textarea" value={f.motivo} onChange={campo('motivo')} maxLength={300} placeholder="Ej.: entrega de equipos de radio, reunión con el coordinador zonal" />
        </div>
        <div className="campo">
          <label htmlFor="s-ini">Desde</label>
          <input id="s-ini" type="date" className="input" value={f.fecha_inicio} min={fechaIsoLocal()} onChange={campo('fecha_inicio')} />
          <span className="ayuda">Vacío = desde hoy.</span>
        </div>
        <div className="campo">
          <label htmlFor="s-fin">Hasta</label>
          <input id="s-fin" type="date" className="input" value={f.fecha_fin} min={f.fecha_inicio || fechaIsoLocal()} onChange={campo('fecha_fin')} />
          <span className="ayuda">Vacío = sin vencimiento (el gestor puede ajustarlo).</span>
        </div>
        <fieldset className="completo" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 14px 14px' }}>
          <legend className="etiqueta-campo" style={{ padding: '0 6px' }}>Horario solicitado (opcional)</legend>
          <EditorHorario valor={horario} onCambiar={setHorario} />
        </fieldset>
        <div className="campo"><label htmlFor="s-tipo">Tipo de vehículo</label>
          <select id="s-tipo" className="select" value={f.tipo_vehiculo} onChange={campo('tipo_vehiculo')}><option value="">—</option>{TIPOS_VEHICULO.map(t => <option key={t}>{t}</option>)}</select></div>
        <div className="campo"><label htmlFor="s-marca">Marca</label>
          <select id="s-marca" className="select" value={f.marca} onChange={campo('marca')}><option value="">—</option>{MARCAS.map(m => <option key={m}>{m}</option>)}</select></div>
        <div className="campo"><label htmlFor="s-modelo">Modelo</label>
          <input id="s-modelo" className="input" value={f.modelo} onChange={campo('modelo')} maxLength={50} /></div>
        <div className="campo"><label htmlFor="s-color">Color</label>
          <select id="s-color" className="select" value={f.color} onChange={campo('color')}><option value="">—</option>{COLORES.map(c => <option key={c}>{c}</option>)}</select></div>
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
    </Modal>
  );
};

/**
 * Aprobación por el gestor de accesos: puede ajustar categoría, vigencia y horario antes de
 * conceder el permiso y, si la solicitud nació de un ingreso, validarlo en el mismo paso.
 */
export const AprobarSolicitud: React.FC<{ s: SolicitudAcceso; onCerrar: () => void; onAprobada: (mensaje: string) => void }> = ({ s, onCerrar, onAprobada }) => {
  const [a, setA] = useState({ categoria: s.categoria, fecha_inicio: s.fecha_inicio ?? '', fecha_fin: s.fecha_fin ?? '', comentario: '' });
  const [horario, setHorario] = useState<Franja[] | null>(s.horario);
  const [validarIngreso, setValidarIngreso] = useState(Boolean(s.deteccion_id));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valido = horarioValido(horario) && (!a.fecha_inicio || !a.fecha_fin || a.fecha_inicio <= a.fecha_fin);

  const aprobar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post(`/solicitudes-acceso/${s.id}/aprobar`, {
        comentario: a.comentario.trim() || undefined,
        ajustes: { categoria: a.categoria, fecha_inicio: a.fecha_inicio || null, fecha_fin: a.fecha_fin || null, horario },
      });
      let mensaje: string = r.data.message;
      if (validarIngreso && s.deteccion_id) {
        try {
          const v = await api.post(`/detecciones/validar/${s.deteccion_id}`, { placa_validada: s.placa, observacion: `Solicitud de acceso #${s.id} aprobada` });
          mensaje += v.data.deteccion?.estado_validacion === 'autorizado'
            ? ' El ingreso quedó autorizado.'
            : ' El ingreso no quedó autorizado: revise el horario o la vigencia del permiso.';
        } catch (e) {
          mensaje += ` No se pudo validar el ingreso: ${mensajeError(e)}`;
        }
      }
      onAprobada(mensaje);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={<>Aprobar solicitud #{s.id} · <Placa valor={s.placa} /></>} subtitulo={`${s.solicitante.nombre} · ${fechaHora(s.fecha_solicitud)}`}
      onCerrar={onCerrar} bloquear={enviando} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-exito" onClick={aprobar} disabled={!valido || enviando}>{enviando ? <Loader2 size={14} className="girar" /> : <ShieldCheck size={14} />} Conceder permiso</button>
      </>}>
      <div className="pila">
        {s.en_lista_alertas && (
          <Aviso tipo="error"><AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Esta placa está en la <b>lista de alertas</b>: aunque se apruebe, cada paso seguirá generando una alerta de seguridad.</Aviso>
        )}
        {s.permiso_actual_id && <Aviso tipo="info">La placa ya tiene un permiso activo: la aprobación lo actualizará con la vigencia y el horario indicados.</Aviso>}
        <dl className="definiciones">
          <dt>Responsable</dt><dd>{s.propietario}{s.departamento ? ` · ${s.departamento}` : ''}</dd>
          <dt>Motivo</dt><dd>{s.motivo}</dd>
          <dt>Vehículo</dt><dd>{[s.vehiculo.tipo, s.vehiculo.marca, s.vehiculo.modelo, s.vehiculo.color].filter(Boolean).join(' · ') || '—'}</dd>
        </dl>
        <div className="form-grid">
          <div className="campo">
            <label htmlFor="a-cat">Categoría</label>
            <select id="a-cat" className="select" value={a.categoria} onChange={e => setA({ ...a, categoria: e.target.value })}>
              {Object.entries(CATEGORIAS_PERMISO).map(([v, e]) => <option key={v} value={v}>{e}</option>)}
            </select>
          </div>
          <div className="campo" />
          <div className="campo"><label htmlFor="a-ini">Vigente desde</label>
            <input id="a-ini" type="date" className="input" value={a.fecha_inicio} onChange={e => setA({ ...a, fecha_inicio: e.target.value })} /></div>
          <div className="campo"><label htmlFor="a-fin">Vigente hasta</label>
            <input id="a-fin" type="date" className="input" value={a.fecha_fin} onChange={e => setA({ ...a, fecha_fin: e.target.value })} />
            <span className="ayuda">Vacío = sin vencimiento.</span></div>
          <fieldset className="completo" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 14px 14px' }}>
            <legend className="etiqueta-campo" style={{ padding: '0 6px' }}>Horario de acceso</legend>
            <EditorHorario valor={horario} onCambiar={setHorario} />
          </fieldset>
          <div className="campo completo"><label htmlFor="a-com">Comentario para el solicitante</label>
            <input id="a-com" className="input" value={a.comentario} maxLength={300} onChange={e => setA({ ...a, comentario: e.target.value })} placeholder="Opcional" /></div>
          {s.deteccion_id && (
            <label className="completo fila" style={{ gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={validarIngreso} onChange={e => setValidarIngreso(e.target.checked)} />
              <span>Validar también el ingreso #{s.deteccion_id} que originó la solicitud</span>
            </label>
          )}
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
    </Modal>
  );
};
