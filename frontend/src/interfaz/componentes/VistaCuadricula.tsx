import React, { useState } from 'react';
import { Camera, GripVertical, X } from 'lucide-react';
import api from '../../infraestructura/api';
import type { Camara } from '../../dominio/tipos';
import { Aviso } from './ui';
import { ReproductorWebRTC, VisorEnVivo } from './envivo';

const CLAVE_SLOTS = 'anpr_nvr_slots_v1';
const CLAVE_CANTIDAD = 'anpr_cuadricula_cantidad_v1';
type CantidadCeldas = 1 | 2 | 4;

function leerSlots(): (number | null)[] {
  try {
    const valor: unknown = JSON.parse(localStorage.getItem(CLAVE_SLOTS) || '[]');
    if (!Array.isArray(valor)) return [null, null, null, null];
    return Array.from({ length: 4 }, (_, i) => Number.isInteger(valor[i]) && valor[i] > 0 ? valor[i] as number : null);
  } catch {
    return [null, null, null, null];
  }
}

function leerCantidad(): CantidadCeldas {
  try {
    const cantidad = Number(localStorage.getItem(CLAVE_CANTIDAD));
    return cantidad === 1 || cantidad === 2 || cantidad === 4 ? cantidad : 4;
  } catch {
    return 4;
  }
}

export const VistaCuadricula: React.FC<{ camaras: Camara[]; motorId: number | null }> = ({ camaras, motorId }) => {
  const [slots, setSlots] = useState<(number | null)[]>(leerSlots);
  const [cantidad, setCantidad] = useState<CantidadCeldas>(leerCantidad);
  const [errorVideo, setErrorVideo] = useState<string | null>(null);

  const guardarSlots = (siguiente: (number | null)[]) => {
    setSlots(siguiente);
    try { localStorage.setItem(CLAVE_SLOTS, JSON.stringify(siguiente)); } catch { /* almacenamiento no disponible */ }
  };
  const cambiarCantidad = (siguiente: CantidadCeldas) => {
    setCantidad(siguiente);
    try { localStorage.setItem(CLAVE_CANTIDAD, String(siguiente)); } catch { /* preferencia no disponible */ }
  };
  const colocar = (id: number, destino: number) => {
    const actual = [...slots];
    const previo = actual.indexOf(id);
    if (previo >= 0 && previo !== destino) [actual[previo], actual[destino]] = [actual[destino], actual[previo]];
    else actual[destino] = id;
    guardarSlots(actual);
  };
  const alSoltar = (e: React.DragEvent, destino: number) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('application/x-anpr-camera'));
    if (Number.isInteger(id) && camaras.some(c => c.id === id)) colocar(id, destino);
  };

  return (
    <div className="pila" style={{ gap: 8 }}>
      <div className="fila" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="texto-secundario">Arrastre cámaras del menú lateral a las celdas. La distribución se conserva entre sesiones.</span>
        <div className="fila" role="group" aria-label="Cantidad de cámaras en la vista cuadrícula">
          {([1, 2, 4] as const).map(n => (
            <button key={n} type="button" className={`btn btn-sm ${cantidad === n ? 'btn-navy' : 'btn-secondary'}`}
              aria-pressed={cantidad === n} aria-label={`Mostrar ${n} ${n === 1 ? 'cámara' : 'cámaras'}`}
              onClick={() => cambiarCantidad(n)}>{n}</button>
          ))}
        </div>
      </div>
      {errorVideo && <Aviso tipo="error">{errorVideo}</Aviso>}
      <div className={`nvr-grid nvr-grid-${cantidad}`} aria-label={`Vista cuadrícula de ${cantidad} cámaras`}>
        {slots.slice(0, cantidad).map((id, indice) => {
          const camara = camaras.find(c => c.id === id);
          return (
            <section key={indice} className="nvr-celda" onDragOver={e => e.preventDefault()} onDrop={e => alSoltar(e, indice)}
              aria-label={`Cámara ${indice + 1}${camara ? `: ${camara.nombre}` : ', vacía'}`}>
              <header className="nvr-celda-cabecera">
                <span className="fila truncar" style={{ gap: 6, minWidth: 0 }}>
                  <GripVertical size={14} />
                  <strong className="truncar">{camara?.nombre ?? `Cámara ${indice + 1}`}</strong>
                  {camara && <span className="nvr-direccion">{camara.direccion === 'salida' ? 'SALIDA' : 'INGRESO'}</span>}
                </span>
                {camara && <button className="btn btn-ghost btn-sm btn-icono" title="Quitar cámara de la celda" aria-label="Quitar cámara"
                  onClick={() => guardarSlots(slots.map((s, i) => i === indice ? null : s))}><X size={14} /></button>}
              </header>
              <div className="nvr-video">
                {camara?.activa
                  ? camara.id === motorId
                    ? <VisorEnVivo camaraId={camara.id} vista={Boolean(camara.rtsp_url_vista)} pausado={false}
                      onFallo={m => setErrorVideo(`${camara.nombre}: ${m}`)} />
                    : <ReproductorWebRTC pausado={false} claveReinicio={camara.id}
                      obtener={async () => {
                        const ticket = (await api.post('/monitoreo/ticket', { alcance: 'stream' })).data;
                        const ruta = `cam_${camara.id}${camara.rtsp_url_vista ? '_vista' : ''}`;
                        return { whep: `${ticket.webrtc}/${ruta}/whep?ticket=${encodeURIComponent(ticket.ticket)}` };
                      }}
                      onFallo={m => setErrorVideo(`${camara.nombre}: ${m}`)} />
                  : camara
                    ? <div className="nvr-vacio">Cámara deshabilitada</div>
                    : <div className="nvr-vacio"><Camera size={22} /><span>Arrastre una cámara aquí</span></div>}
              </div>
            </section>
          );
        })}
      </div>
      <span className="texto-secundario">El motor ANPR procesa únicamente la cámara activa asignada al sistema.</span>
    </div>
  );
};
