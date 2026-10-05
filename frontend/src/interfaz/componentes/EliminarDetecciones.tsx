import React, { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import type { Deteccion } from '../../dominio/tipos';
import { fechaHora, numero } from '../../dominio/formato';
import { formatearPlaca, validarTexto } from '../../dominio/validacion';
import { reglaMotivoEliminacion } from '../../dominio/reglas';
import { Aviso, Modal, Placa } from './ui';
import { CampoTexto } from './campos';
import { useNotificar } from './Notificaciones';

/**
 * Eliminación de registros de ingreso (solo Administrador). Se borra el registro y su
 * evidencia fotográfica; cada eliminación queda en la auditoría con su motivo.
 */

const MOTIVOS = ['Falso positivo (no corresponde a un vehículo)', 'Registro duplicado', 'Prueba del sistema'];
const PALABRA_CONFIRMACION = 'ELIMINAR';

/** Motivo válido para la API: un registro exige 3 caracteres; la eliminación masiva, 5 (dominio/detecciones.ts). */
const motivoValido = (motivo: string, minimo: number) => validarTexto(motivo, reglaMotivoEliminacion(minimo)).ok;

const SelectorMotivo: React.FC<{ valor: string; onCambiar: (v: string) => void; minimo: number }> = ({ valor, onCambiar, minimo }) => {
  const [otro, setOtro] = useState(false);
  return (
    <div className="campo">
      <span className="etiqueta-campo">Motivo (queda registrado en la auditoría)*</span>
      <div className="fila" style={{ gap: 6 }}>
        {MOTIVOS.map(m => (
          <button key={m} type="button" className={`btn btn-sm ${!otro && valor === m ? 'btn-navy' : 'btn-secondary'}`} onClick={() => { setOtro(false); onCambiar(m); }}>{m}</button>
        ))}
        <button type="button" className={`btn btn-sm ${otro ? 'btn-navy' : 'btn-secondary'}`} onClick={() => { setOtro(true); onCambiar(''); }}>Otro…</button>
      </div>
      {otro && (
        <CampoTexto id="motivo-eliminar" etiqueta="Describa el motivo" multilinea autoFocus valor={valor} onCambiar={onCambiar}
          regla={reglaMotivoEliminacion(minimo)} placeholder={`Mínimo ${minimo} caracteres`} ayuda={`Entre ${minimo} y 300 caracteres.`} />
      )}
    </div>
  );
};

export const EliminarUno: React.FC<{ d: Deteccion; onCerrar: () => void; onEliminada?: (id: number) => void }> = ({ d, onCerrar, onEliminada }) => {
  const notificar = useNotificar();
  const [motivo, setMotivo] = useState(MOTIVOS[0]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eliminar = async () => {
    setEnviando(true);
    setError(null);
    try {
      await api.delete(`/detecciones/${d.id}`, { data: { motivo: motivo.trim() } });
      notificar('exito', `Registro #${d.id} eliminado`, d.placa ? formatearPlaca(d.placa) : undefined);
      onEliminada?.(d.id);
      onCerrar();
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };
  return (
    <Modal titulo="Eliminar registro" subtitulo={`#${d.id} · ${fechaHora(d.fecha_hora_ingreso)}${d.camara ? ` · ${d.camara.nombre}` : ''}`}
      onCerrar={onCerrar} tamano="normal" bloquear={enviando}
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-primary" onClick={eliminar} disabled={enviando || !motivoValido(motivo, 3)}>
          {enviando ? <Loader2 size={14} className="girar" /> : <Trash2 size={14} />} Eliminar
        </button>
      </>}>
      <div className="pila" style={{ gap: 14 }}>
        <div className="fila"><Placa valor={d.placa} /> <span className="texto-secundario">Se eliminará el registro y sus fotografías. No se puede deshacer.</span></div>
        <SelectorMotivo valor={motivo} onCambiar={setMotivo} minimo={3} />
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
    </Modal>
  );
};

/**
 * Eliminación masiva: todos los registros o los que cumplen los filtros indicados.
 * Exige escribir ELIMINAR y un motivo.
 */
export const EliminarVarios: React.FC<{
  total: number; filtros?: Record<string, string | undefined>; descripcion: string;
  onCerrar: () => void; onHecho?: (eliminados: number) => void;
}> = ({ total, filtros, descripcion, onCerrar, onHecho }) => {
  const notificar = useNotificar();
  const [motivo, setMotivo] = useState(MOTIVOS[2]);
  const [confirmacion, setConfirmacion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valido = confirmacion === PALABRA_CONFIRMACION && motivoValido(motivo, 5);
  const eliminar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.delete('/detecciones', { params: filtros, data: { motivo: motivo.trim(), confirmacion } });
      notificar('exito', r.data.message, 'La operación quedó registrada en la auditoría.');
      onHecho?.(r.data.total);
      onCerrar();
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };
  return (
    <Modal titulo="Eliminar registros" subtitulo={descripcion} onCerrar={onCerrar} bloquear={enviando}
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-primary" onClick={eliminar} disabled={!valido || enviando}>
          {enviando ? <Loader2 size={14} className="girar" /> : <Trash2 size={14} />} Eliminar {numero(total)} {total === 1 ? 'registro' : 'registros'}
        </button>
      </>}>
      <div className="pila" style={{ gap: 14 }}>
        <Aviso tipo="error">
          Se eliminarán <b>{numero(total)} {total === 1 ? 'registro' : 'registros'}</b> de ingreso con sus fotografías de evidencia. Esta acción
          no se puede deshacer y afecta los reportes y la evaluación del sistema.
        </Aviso>
        <SelectorMotivo valor={motivo} onCambiar={setMotivo} minimo={5} />
        <div className="campo">
          <label htmlFor="conf-eliminar">Para confirmar escriba <b>{PALABRA_CONFIRMACION}</b></label>
          <input id="conf-eliminar" className="input mono" value={confirmacion} maxLength={PALABRA_CONFIRMACION.length} autoComplete="off" spellCheck={false}
            onChange={e => setConfirmacion(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
        </div>
        {error && <Aviso tipo="error">{error}</Aviso>}
      </div>
    </Modal>
  );
};
