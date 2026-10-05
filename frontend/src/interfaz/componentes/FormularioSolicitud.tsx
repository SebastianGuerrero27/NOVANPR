import React, { useState } from 'react';
import { AlertTriangle, Loader2, Save, Send, ShieldCheck } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import type { Franja, SolicitudAcceso } from '../../dominio/tipos';
import { CATEGORIAS_PERMISO, fechaHora, fechaIsoLocal } from '../../dominio/formato';
import {
  errorDe, erroresTexto, normalizarPlaca, placaPropuesta, sinErrores, validarFecha, validarPlaca, validarTexto, valorPrecargado,
} from '../../dominio/validacion';
import { REGLA_COMENTARIO_APROBACION, REGLAS_SOLICITUD, REGLAS_VEHICULO } from '../../dominio/reglas';
import { Aviso, Modal, Placa } from './ui';
import { CampoFecha, CampoPlaca, CampoTexto } from './campos';
import { EditorHorario, horarioValido } from './EditorHorario';
import { COLORES, conValorActual, MARCAS } from './FormularioLista';
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
 * Solicitud de autorización de una placa (guardia): el gestor de permisos la
 * recibe como notificación y decide. Se abre desde el aviso de vehículo no autorizado, el
 * detalle de un ingreso o la pantalla de solicitudes. Con `solicitud` edita una solicitud propia
 * pendiente (PUT, mismo cuerpo que el alta): la API rechaza la edición si ya fue resuelta.
 */
export const FormularioSolicitud: React.FC<{
  inicial?: DatosIniciales; solicitud?: SolicitudAcceso; onCerrar: () => void; onEnviada: (s: SolicitudAcceso) => void;
}> = ({ inicial, solicitud, onCerrar, onEnviada }) => {
  const [f, setF] = useState(() => solicitud
    ? {
      placa: normalizarPlaca(solicitud.placa), propietario: solicitud.propietario, departamento: solicitud.departamento ?? '',
      categoria: solicitud.categoria, motivo: solicitud.motivo,
      // Los campos de opciones no muestran error: un valor anterior a las reglas se descarta y se vuelve a elegir
      tipo_vehiculo: valorPrecargado(solicitud.vehiculo.tipo, REGLAS_VEHICULO.tipo_vehiculo),
      marca: valorPrecargado(solicitud.vehiculo.marca, REGLAS_VEHICULO.marca),
      modelo: solicitud.vehiculo.modelo ?? '',
      color: valorPrecargado(solicitud.vehiculo.color, REGLAS_VEHICULO.color),
      fecha_inicio: solicitud.fecha_inicio?.slice(0, 10) ?? '', fecha_fin: solicitud.fecha_fin?.slice(0, 10) ?? '',
    }
    : {
      placa: placaPropuesta(inicial?.placa), propietario: '', departamento: '', categoria: 'VISITANTE', motivo: '',
      // Atributos que informó la cámara: se descartan los que no cumplen la regla del campo
      tipo_vehiculo: valorPrecargado(inicial?.tipo_vehiculo, REGLAS_VEHICULO.tipo_vehiculo),
      marca: valorPrecargado(inicial?.marca, REGLAS_VEHICULO.marca),
      modelo: valorPrecargado(inicial?.modelo, REGLAS_VEHICULO.modelo),
      color: valorPrecargado(inicial?.color, REGLAS_VEHICULO.color),
      fecha_inicio: '', fecha_fin: fechaIsoLocal(),
    });
  const [horario, setHorario] = useState<Franja[] | null>(solicitud?.horario ?? null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const poner = (k: keyof typeof f) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const fechasOk = !f.fecha_inicio || !f.fecha_fin || f.fecha_inicio <= f.fecha_fin;
  const valido = horarioValido(horario) && fechasOk && sinErrores({
    placa: errorDe(validarPlaca(f.placa)),
    ...erroresTexto(f, { ...REGLAS_SOLICITUD, ...REGLAS_VEHICULO }),
    fecha_inicio: errorDe(validarFecha(f.fecha_inicio, { etiqueta: 'Fecha de inicio' })),
    fecha_fin: errorDe(validarFecha(f.fecha_fin, { etiqueta: 'Fecha de fin' })),
  });
  // Con la placa ya escrita (edición o lectura de la cámara) el foco va al responsable
  const [placaPrecargada] = useState(() => f.placa !== '');

  const enviar = async () => {
    setEnviando(true);
    setError(null);
    const cuerpo = {
      ...f, horario, fecha_inicio: f.fecha_inicio || null, fecha_fin: f.fecha_fin || null,
      deteccion_id: solicitud ? solicitud.deteccion_id ?? undefined : inicial?.deteccion_id,
    };
    try {
      const r = solicitud ? await api.put(`/solicitudes-acceso/${solicitud.id}`, cuerpo) : await api.post('/solicitudes-acceso', cuerpo);
      onEnviada(r.data.solicitud);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={solicitud ? <>Editar solicitud #{solicitud.id}</> : 'Solicitar autorización de ingreso'}
      subtitulo={solicitud
        ? 'Puede corregirla mientras esté pendiente. El gestor de permisos verá los datos actualizados.'
        : 'El gestor de permisos recibirá la solicitud de inmediato y decidirá si concede el permiso.'}
      onCerrar={onCerrar} bloquear={enviando} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-navy" onClick={enviar} disabled={!valido || enviando}>
          {enviando ? <Loader2 size={14} className="girar" /> : solicitud ? <Save size={14} /> : <Send size={14} />} {solicitud ? 'Guardar cambios' : 'Enviar solicitud'}
        </button>
      </>}>
      <div className="form-grid">
        <CampoPlaca id="s-placa" etiqueta="Placa*" valor={f.placa} onCambiar={poner('placa')} autoFocus={!placaPrecargada} />
        <div className="campo">
          <label htmlFor="s-cat">Categoría</label>
          <select id="s-cat" className="select" value={f.categoria} onChange={campo('categoria')}>
            {Object.entries(CATEGORIAS_PERMISO).map(([v, e]) => <option key={v} value={v}>{e}</option>)}
          </select>
        </div>
        <CampoTexto id="s-prop" etiqueta="Conductor o responsable*" valor={f.propietario} onCambiar={poner('propietario')}
          regla={REGLAS_SOLICITUD.propietario} autoFocus={placaPrecargada} placeholder="Nombres y apellidos / empresa" />
        <CampoTexto id="s-dep" etiqueta="Unidad que visita" valor={f.departamento} onCambiar={poner('departamento')}
          regla={REGLAS_SOLICITUD.departamento} placeholder="Ej.: Dirección Zonal" />
        <CampoTexto id="s-motivo" className="completo" etiqueta="Motivo del ingreso*" valor={f.motivo} onCambiar={poner('motivo')}
          regla={REGLAS_SOLICITUD.motivo} multilinea ayuda="Entre 5 y 300 caracteres."
          placeholder="Ej.: entrega de equipos de radio, reunión con el coordinador zonal" />
        <CampoFecha id="s-ini" etiqueta="Desde" nombre="Fecha de inicio" valor={f.fecha_inicio} min={solicitud ? undefined : fechaIsoLocal()}
          onCambiar={poner('fecha_inicio')} ayuda="Vacío = desde hoy." />
        <CampoFecha id="s-fin" etiqueta="Hasta" nombre="Fecha de fin" valor={f.fecha_fin} min={f.fecha_inicio || (solicitud ? undefined : fechaIsoLocal())}
          onCambiar={poner('fecha_fin')} error={fechasOk ? null : 'Debe ser posterior a la fecha de inicio.'}
          ayuda="Vacío = sin vencimiento (el gestor puede ajustarlo)." />
        <fieldset className="completo" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 14px 14px' }}>
          <legend className="etiqueta-campo" style={{ padding: '0 6px' }}>Horario solicitado (opcional)</legend>
          <EditorHorario valor={horario} onCambiar={setHorario} />
        </fieldset>
        <div className="campo"><label htmlFor="s-tipo">Tipo de vehículo</label>
          <select id="s-tipo" className="select" value={f.tipo_vehiculo} onChange={campo('tipo_vehiculo')}><option value="">—</option>{conValorActual(TIPOS_VEHICULO, f.tipo_vehiculo).map(t => <option key={t}>{t}</option>)}</select></div>
        <div className="campo"><label htmlFor="s-marca">Marca</label>
          <select id="s-marca" className="select" value={f.marca} onChange={campo('marca')}><option value="">—</option>{conValorActual(MARCAS, f.marca).map(m => <option key={m}>{m}</option>)}</select></div>
        <CampoTexto id="s-modelo" etiqueta="Modelo" valor={f.modelo} onCambiar={poner('modelo')} regla={REGLAS_VEHICULO.modelo} />
        <div className="campo"><label htmlFor="s-color">Color</label>
          <select id="s-color" className="select" value={f.color} onChange={campo('color')}><option value="">—</option>{conValorActual(COLORES, f.color).map(c => <option key={c}>{c}</option>)}</select></div>
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
    </Modal>
  );
};

/**
 * Aprobación por el gestor de permisos: puede ajustar categoría, vigencia y horario antes de
 * conceder el permiso y, si la solicitud nació de un ingreso y tiene detecciones:validar (Admin),
 * validarlo en el mismo paso. El gestor de permisos no valida ingresos: lo hace la garita al
 * recibir la resolución.
 */
export const AprobarSolicitud: React.FC<{ s: SolicitudAcceso; onCerrar: () => void; onAprobada: (mensaje: string) => void }> = ({ s, onCerrar, onAprobada }) => {
  const [a, setA] = useState({ categoria: s.categoria, fecha_inicio: s.fecha_inicio?.slice(0, 10) ?? '', fecha_fin: s.fecha_fin?.slice(0, 10) ?? '', comentario: '' });
  const [horario, setHorario] = useState<Franja[] | null>(s.horario);
  const { puede } = useAuth();
  const puedeValidar = puede('detecciones:validar');
  const [validarIngreso, setValidarIngreso] = useState(Boolean(s.deteccion_id) && puedeValidar);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fechasOk = !a.fecha_inicio || !a.fecha_fin || a.fecha_inicio <= a.fecha_fin;
  const valido = horarioValido(horario) && fechasOk && sinErrores({
    comentario: errorDe(validarTexto(a.comentario, REGLA_COMENTARIO_APROBACION)),
    fecha_inicio: errorDe(validarFecha(a.fecha_inicio, { etiqueta: 'Fecha de inicio' })),
    fecha_fin: errorDe(validarFecha(a.fecha_fin, { etiqueta: 'Fecha de fin' })),
  });

  const aprobar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post(`/solicitudes-acceso/${s.id}/aprobar`, {
        comentario: a.comentario.trim() || undefined,
        ajustes: { categoria: a.categoria, fecha_inicio: a.fecha_inicio || null, fecha_fin: a.fecha_fin || null, horario },
        // Lo que el gestor revisó: si el solicitante la editó mientras tanto, la API no la aprueba (409)
        version: s.version,
      });
      let mensaje: string = r.data.message;
      if (validarIngreso && puedeValidar && s.deteccion_id) {
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
        <button className="btn btn-exito" onClick={aprobar} disabled={!valido || enviando}>{enviando ? <Loader2 size={14} className="girar" /> : <ShieldCheck size={14} />} Aprobar y agregar a lista blanca</button>
      </>}>
      <div className="pila">
        {s.en_lista_alertas && (
          <Aviso tipo="error"><AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Esta placa está en la <b>lista negra</b>: aunque se apruebe, cada paso seguirá generando una alerta de seguridad.</Aviso>
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
          <CampoFecha id="a-ini" etiqueta="Vigente desde" nombre="Fecha de inicio" valor={a.fecha_inicio} onCambiar={v => setA({ ...a, fecha_inicio: v })} />
          <CampoFecha id="a-fin" etiqueta="Vigente hasta" nombre="Fecha de fin" valor={a.fecha_fin} onCambiar={v => setA({ ...a, fecha_fin: v })}
            error={fechasOk ? null : 'Debe ser posterior a la fecha de inicio.'} ayuda="Vacío = sin vencimiento." />
          <fieldset className="completo" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 14px 14px' }}>
            <legend className="etiqueta-campo" style={{ padding: '0 6px' }}>Horario de acceso</legend>
            <EditorHorario valor={horario} onCambiar={setHorario} />
          </fieldset>
          <CampoTexto id="a-com" className="completo" etiqueta="Comentario para el solicitante" valor={a.comentario}
            onCambiar={v => setA({ ...a, comentario: v })} regla={REGLA_COMENTARIO_APROBACION} placeholder="Opcional" />
          {s.deteccion_id && puedeValidar && (
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
