import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import type { Franja, RegistroLista } from '../lib/tipos';
import { CATEGORIAS_PERMISO, fechaIsoLocal } from '../lib/formato';
import { Aviso, Modal } from './ui';
import { TIPOS_VEHICULO } from './deteccion';
import { EditorHorario, horarioValido } from './EditorHorario';

// Mismas marcas y colores que usa el reconocedor (services/anpr/app/data/catalogo_vehiculos_ecuador.json),
// para que lo registrado sea comparable con lo que observa la cámara.
export const MARCAS = [
  'Chevrolet', 'Kia', 'Hyundai', 'Toyota', 'Nissan', 'Mazda', 'Great Wall', 'Haval', 'Chery', 'JAC',
  'Renault', 'Ford', 'Volkswagen', 'Suzuki', 'Mitsubishi', 'Peugeot', 'Honda', 'Isuzu', 'Hino', 'DFSK',
];
export const COLORES = ['blanco', 'negro', 'gris', 'plateado', 'rojo', 'azul', 'verde', 'amarillo', 'naranja', 'café', 'beige', 'vino'];

export type TipoLista = 'autorizados' | 'alertas';
export const RUTA_API: Record<TipoLista, string> = { autorizados: '/vehiculos-autorizados', alertas: '/blacklist' };

/**
 * Alta y edición de un registro del padrón de autorizados (permiso de placa con categoría,
 * vigencia y franjas horarias) o de la lista de alertas.
 */
export const FormularioLista: React.FC<{
  tipo: TipoLista; registro?: RegistroLista; inicial?: Partial<Record<string, string | null>>;
  onCerrar: () => void; onGuardado: (r: RegistroLista) => void;
}> = ({ tipo, registro, inicial, onCerrar, onGuardado }) => {
  const base = registro ?? inicial ?? {};
  const [f, setF] = useState({
    placa: String(base.placa ?? ''),
    propietario: String((base as any).propietario ?? ''),
    departamento: String((base as any).departamento ?? ''),
    tipo_vehiculo: String((base as any).tipo_vehiculo ?? ''),
    motivo: String((base as any).motivo ?? ''),
    nivel_alerta: String((base as any).nivel_alerta ?? 'ALTA'),
    marca: String(base.marca ?? ''),
    modelo: String(base.modelo ?? ''),
    color: String(base.color ?? ''),
    fecha_vencimiento: registro?.fecha_vencimiento ? String(registro.fecha_vencimiento).slice(0, 10) : '',
    observaciones: String((base as any).observaciones ?? ''),
    categoria: String((base as any).categoria ?? 'FUNCIONARIO'),
    fecha_inicio: registro?.fecha_inicio ? String(registro.fecha_inicio).slice(0, 10) : '',
  });
  const [horario, setHorario] = useState<Franja[] | null>(registro?.horario ?? null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const placa = f.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fechasOk = !f.fecha_inicio || !f.fecha_vencimiento || f.fecha_inicio <= f.fecha_vencimiento;
  const valido = placa.length >= 4 && placa.length <= 10 && fechasOk && horarioValido(horario)
    && (tipo === 'autorizados' ? f.propietario.trim().length >= 3 : f.motivo.trim().length >= 5);
  const autorizados = tipo === 'autorizados';

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    const cuerpo = autorizados
      ? {
        placa, propietario: f.propietario, departamento: f.departamento, categoria: f.categoria, tipo_vehiculo: f.tipo_vehiculo,
        marca: f.marca, modelo: f.modelo, color: f.color, fecha_inicio: f.fecha_inicio || null, fecha_vencimiento: f.fecha_vencimiento || null,
        horario, observaciones: f.observaciones,
      }
      : { placa, motivo: f.motivo, nivel_alerta: f.nivel_alerta, marca: f.marca, modelo: f.modelo, color: f.color, fecha_vencimiento: f.fecha_vencimiento || null, observaciones: f.observaciones };
    try {
      const r = registro ? await api.put(`${RUTA_API[tipo]}/${registro.id}`, cuerpo) : await api.post(RUTA_API[tipo], cuerpo);
      onGuardado(r.data.item);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={`${registro ? 'Editar' : 'Agregar'} ${autorizados ? 'permiso de placa' : 'placa con alerta'}`}
      subtitulo={autorizados ? 'Dentro de su vigencia y horario, el vehículo ingresa con decisión automática “Autorizado”.' : 'Cada paso de esta placa genera una alerta en el monitoreo.'}
      onCerrar={onCerrar} bloquear={enviando} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className={`btn ${autorizados ? 'btn-navy' : 'btn-primary'}`} onClick={guardar} disabled={!valido || enviando}>{enviando && <Loader2 size={14} className="girar" />} Guardar</button>
      </>}>
      <div className="form-grid">
        <div className="campo">
          <label htmlFor="l-placa">Placa*</label>
          <input id="l-placa" className="input placa-input" value={f.placa} onChange={e => setF(x => ({ ...x, placa: e.target.value.toUpperCase() }))} maxLength={10} autoFocus placeholder="ABC1234" />
        </div>
        {autorizados ? (
          <>
            <div className="campo">
              <label htmlFor="l-prop">Propietario o responsable*</label>
              <input id="l-prop" className="input" value={f.propietario} onChange={campo('propietario')} maxLength={150} placeholder="Nombres y apellidos / institución" />
            </div>
            <div className="campo">
              <label htmlFor="l-dep">Departamento o unidad</label>
              <input id="l-dep" className="input" value={f.departamento} onChange={campo('departamento')} maxLength={100} placeholder="Ej.: Dirección Zonal, Proveedor" />
            </div>
            <div className="campo">
              <label htmlFor="l-cat">Categoría del permiso</label>
              <select id="l-cat" className="select" value={f.categoria} onChange={campo('categoria')}>
                {Object.entries(CATEGORIAS_PERMISO).map(([v, e]) => <option key={v} value={v}>{e}</option>)}
              </select>
            </div>
            <div className="campo">
              <label htmlFor="l-tipo">Tipo de vehículo</label>
              <select id="l-tipo" className="select" value={f.tipo_vehiculo} onChange={campo('tipo_vehiculo')}>
                <option value="">Sin especificar</option>{TIPOS_VEHICULO.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </>
        ) : (
          <>
            <div className="campo">
              <label htmlFor="l-nivel">Nivel de alerta*</label>
              <select id="l-nivel" className="select" value={f.nivel_alerta} onChange={campo('nivel_alerta')}>
                <option value="CRITICA">Crítica</option><option value="ALTA">Alta</option><option value="MEDIA">Media</option>
              </select>
            </div>
            <div className="campo completo">
              <label htmlFor="l-motivo">Motivo*</label>
              <input id="l-motivo" className="input" value={f.motivo} onChange={campo('motivo')} maxLength={255} placeholder="Ej.: vehículo reportado como robado (parte policial N.º …)" />
            </div>
          </>
        )}
        {autorizados && (
          <div className="campo">
            <label htmlFor="l-inicio">Vigente desde</label>
            <input id="l-inicio" type="date" className="input" value={f.fecha_inicio} onChange={campo('fecha_inicio')} />
            <span className="ayuda">Vacío = desde hoy. Útil para visitas programadas.</span>
          </div>
        )}
        <div className="campo">
          <label htmlFor="l-vence">{autorizados ? 'Vigente hasta' : 'Alerta vigente hasta'}</label>
          <input id="l-vence" type="date" className="input" value={f.fecha_vencimiento} min={registro ? undefined : fechaIsoLocal()} onChange={campo('fecha_vencimiento')} />
          <span className="ayuda">{fechasOk ? `Vacío = sin vencimiento.${autorizados ? ' Útil para visitas y proveedores.' : ''}` : 'Debe ser posterior a la fecha de inicio.'}</span>
        </div>
        {autorizados && (
          <fieldset className="completo" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 14px 14px' }}>
            <legend className="etiqueta-campo" style={{ padding: '0 6px' }}>Horario de acceso</legend>
            <p className="texto-secundario" style={{ marginBottom: 10 }}>Fuera de estas franjas la placa no se autoriza automáticamente: el personal recibe una alerta “fuera de horario” y solo un gestor puede conceder una excepción.</p>
            <EditorHorario valor={horario} onCambiar={setHorario} />
          </fieldset>
        )}
        <fieldset className="completo" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 14px 14px' }}>
          <legend className="etiqueta-campo" style={{ padding: '0 6px' }}>Vehículo · segundo factor (opcional)</legend>
          <p className="texto-secundario" style={{ marginBottom: 10 }}>Si la cámara observa esta placa en un vehículo de otra marca o color, el sistema lo advierte como posible placa clonada o lectura errónea.</p>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <div className="campo"><label htmlFor="l-marca">Marca</label>
              <select id="l-marca" className="select" value={f.marca} onChange={campo('marca')}><option value="">—</option>{MARCAS.map(m => <option key={m}>{m}</option>)}</select></div>
            <div className="campo"><label htmlFor="l-modelo">Modelo</label>
              <input id="l-modelo" className="input" value={f.modelo} onChange={campo('modelo')} maxLength={50} placeholder="Ej.: Aveo" /></div>
            <div className="campo"><label htmlFor="l-color">Color</label>
              <select id="l-color" className="select" value={f.color} onChange={campo('color')}><option value="">—</option>{COLORES.map(c => <option key={c}>{c}</option>)}</select></div>
          </div>
        </fieldset>
        <div className="campo completo">
          <label htmlFor="l-obs">Observaciones</label>
          <textarea id="l-obs" className="textarea" value={f.observaciones} onChange={campo('observaciones')} maxLength={255} placeholder="Información útil para el personal de la garita" />
        </div>
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
    </Modal>
  );
};
