import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import type { Franja, RegistroLista } from '../../dominio/tipos';
import { CATEGORIAS_PERMISO, fechaIsoLocal } from '../../dominio/formato';
import { errorDe, erroresTexto, normalizarPlaca, placaPropuesta, sinErrores, validarPlaca, valorPrecargado } from '../../dominio/validacion';
import { REGLA_OBSERVACIONES, REGLAS_LISTA_BLANCA, REGLAS_LISTA_NEGRA, REGLAS_VEHICULO } from '../../dominio/reglas';
import { Aviso, Modal } from './ui';
import { CampoFecha, CampoPlaca, CampoTexto } from './campos';
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

/** Opciones de una lista más el valor actual si no está en ella (p. ej. una marca informada por la cámara). */
export const conValorActual = (opciones: string[], valor: string) => (valor && !opciones.includes(valor) ? [valor, ...opciones] : opciones);

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
    // Un registro guardado conserva su placa; una lectura de la cámara solo se propone si cabe en una placa
    placa: registro ? normalizarPlaca(registro.placa) : placaPropuesta(inicial?.placa),
    propietario: String((base as any).propietario ?? ''),
    departamento: String((base as any).departamento ?? ''),
    tipo_vehiculo: valorPrecargado((base as any).tipo_vehiculo, REGLAS_VEHICULO.tipo_vehiculo),
    motivo: String((base as any).motivo ?? ''),
    nivel_alerta: String((base as any).nivel_alerta ?? 'ALTA'),
    marca: valorPrecargado(base.marca, REGLAS_VEHICULO.marca),
    modelo: String(base.modelo ?? ''),
    color: valorPrecargado(base.color, REGLAS_VEHICULO.color),
    fecha_vencimiento: registro?.fecha_vencimiento ? String(registro.fecha_vencimiento).slice(0, 10) : '',
    observaciones: String((base as any).observaciones ?? ''),
    categoria: String((base as any).categoria ?? 'FUNCIONARIO'),
    fecha_inicio: registro?.fecha_inicio ? String(registro.fecha_inicio).slice(0, 10) : '',
  });
  const [horario, setHorario] = useState<Franja[] | null>(registro?.horario ?? null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(x => ({ ...x, [k]: e.target.value }));
  const poner = (k: keyof typeof f) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const autorizados = tipo === 'autorizados';
  const placa = f.placa;
  const fechasOk = !f.fecha_inicio || !f.fecha_vencimiento || f.fecha_inicio <= f.fecha_vencimiento;
  // Mismas reglas que dominio/listas.ts: el botón se habilita solo si todo es válido
  const valido = horarioValido(horario) && fechasOk && sinErrores({
    placa: errorDe(validarPlaca(f.placa)),
    ...(autorizados ? erroresTexto(f, REGLAS_LISTA_BLANCA) : erroresTexto(f, REGLAS_LISTA_NEGRA)),
    ...erroresTexto(f, { ...REGLAS_VEHICULO, observaciones: REGLA_OBSERVACIONES }),
  });

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
    <Modal titulo={`${registro ? `Editar registro de la ${autorizados ? 'lista blanca' : 'lista negra'}` : `Agregar ${autorizados ? 'vehículo a la lista blanca' : 'placa a la lista negra'}`}`}
      subtitulo={autorizados ? 'Dentro de su vigencia y horario, el vehículo ingresa con decisión automática “Autorizado”.' : 'Cada paso de esta placa genera una alerta en el monitoreo.'}
      onCerrar={onCerrar} bloquear={enviando} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className={`btn ${autorizados ? 'btn-navy' : 'btn-primary'}`} onClick={guardar} disabled={!valido || enviando}>{enviando && <Loader2 size={14} className="girar" />} Guardar</button>
      </>}>
      <div className="form-grid">
        <CampoPlaca id="l-placa" etiqueta="Placa*" valor={f.placa} onCambiar={poner('placa')} autoFocus />
        {autorizados ? (
          <>
            <CampoTexto id="l-prop" etiqueta="Propietario o responsable*" valor={f.propietario} onCambiar={poner('propietario')}
              regla={REGLAS_LISTA_BLANCA.propietario} placeholder="Nombres y apellidos / institución" />
            <CampoTexto id="l-dep" etiqueta="Departamento o unidad" valor={f.departamento} onCambiar={poner('departamento')}
              regla={REGLAS_LISTA_BLANCA.departamento} placeholder="Ej.: Dirección Zonal, Proveedor" />
            <div className="campo">
              <label htmlFor="l-cat">Categoría del permiso</label>
              <select id="l-cat" className="select" value={f.categoria} onChange={campo('categoria')}>
                {Object.entries(CATEGORIAS_PERMISO).map(([v, e]) => <option key={v} value={v}>{e}</option>)}
              </select>
            </div>
            <div className="campo">
              <label htmlFor="l-tipo">Tipo de vehículo</label>
              <select id="l-tipo" className="select" value={f.tipo_vehiculo} onChange={campo('tipo_vehiculo')}>
                <option value="">Sin especificar</option>{conValorActual(TIPOS_VEHICULO, f.tipo_vehiculo).map(t => <option key={t}>{t}</option>)}
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
            <CampoTexto id="l-motivo" className="completo" etiqueta="Motivo*" valor={f.motivo} onCambiar={poner('motivo')}
              regla={REGLAS_LISTA_NEGRA.motivo} placeholder="Ej.: vehículo reportado como robado (parte policial N. …)" />
          </>
        )}
        {autorizados && (
          <CampoFecha id="l-inicio" etiqueta="Vigente desde" nombre="Fecha de inicio" valor={f.fecha_inicio} onCambiar={poner('fecha_inicio')}
            ayuda="Vacío = desde hoy. Útil para visitas programadas." />
        )}
        <CampoFecha id="l-vence" etiqueta={autorizados ? 'Vigente hasta' : 'Alerta vigente hasta'} nombre="Fecha de vencimiento"
          valor={f.fecha_vencimiento} min={registro ? undefined : fechaIsoLocal()} onCambiar={poner('fecha_vencimiento')}
          error={fechasOk ? null : 'Debe ser posterior a la fecha de inicio.'}
          ayuda={`Vacío = sin vencimiento.${autorizados ? ' Útil para visitas y proveedores.' : ''}`} />
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
              <select id="l-marca" className="select" value={f.marca} onChange={campo('marca')}><option value="">—</option>{conValorActual(MARCAS, f.marca).map(m => <option key={m}>{m}</option>)}</select></div>
            <CampoTexto id="l-modelo" etiqueta="Modelo" valor={f.modelo} onCambiar={poner('modelo')} regla={REGLAS_VEHICULO.modelo} placeholder="Ej.: Aveo" />
            <div className="campo"><label htmlFor="l-color">Color</label>
              <select id="l-color" className="select" value={f.color} onChange={campo('color')}><option value="">—</option>{conValorActual(COLORES, f.color).map(c => <option key={c}>{c}</option>)}</select></div>
          </div>
        </fieldset>
        <CampoTexto id="l-obs" className="completo" etiqueta="Observaciones" valor={f.observaciones} onCambiar={poner('observaciones')}
          regla={REGLA_OBSERVACIONES} multilinea placeholder="Información útil para el personal de la garita" />
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
    </Modal>
  );
};
