import React from 'react';
import { Clock, Plus, Trash2 } from 'lucide-react';
import type { Franja } from '../../dominio/tipos';

/**
 * Editor de franjas horarias de un permiso de placa. Días ISO 8601 (1 = lunes … 7 = domingo);
 * una franja cuya hora final es menor o igual a la inicial termina al día siguiente (turnos
 * nocturnos). Sin franjas = sin restricción horaria (24/7). El backend valida lo mismo
 * (dominio/horario.ts).
 */

const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const NOMBRES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const PRESETS: { etiqueta: string; valor: Franja[] | null }[] = [
  { etiqueta: 'Sin restricción (24/7)', valor: null },
  { etiqueta: 'Laboral L–V 07:00–19:00', valor: [{ dias: [1, 2, 3, 4, 5], desde: '07:00', hasta: '19:00' }] },
  { etiqueta: 'L–V + sábado mañana', valor: [{ dias: [1, 2, 3, 4, 5], desde: '07:00', hasta: '19:00' }, { dias: [6], desde: '08:00', hasta: '13:00' }] },
  { etiqueta: 'Turno nocturno 19:00–07:00', valor: [{ dias: [1, 2, 3, 4, 5, 6, 7], desde: '19:00', hasta: '07:00' }] },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function horarioValido(h: Franja[] | null): boolean {
  return !h || h.every(f => f.dias.length > 0 && HHMM.test(f.desde) && HHMM.test(f.hasta) && f.desde !== f.hasta);
}

export const EditorHorario: React.FC<{ valor: Franja[] | null; onCambiar: (h: Franja[] | null) => void; deshabilitado?: boolean }> = ({ valor, onCambiar, deshabilitado }) => {
  const franjas = valor ?? [];
  const cambiar = (i: number, f: Partial<Franja>) => onCambiar(franjas.map((x, j) => (j === i ? { ...x, ...f } : x)));
  const alternarDia = (i: number, dia: number) => {
    const dias = franjas[i].dias.includes(dia) ? franjas[i].dias.filter(d => d !== dia) : [...franjas[i].dias, dia].sort((a, b) => a - b);
    cambiar(i, { dias });
  };
  const quitar = (i: number) => {
    const resto = franjas.filter((_, j) => j !== i);
    onCambiar(resto.length ? resto : null);
  };

  return (
    <div className="pila" style={{ gap: 8 }}>
      <div className="horario-presets">
        {PRESETS.map(p => (
          <button key={p.etiqueta} type="button" className="btn btn-ghost btn-sm" disabled={deshabilitado}
            style={{ border: '1px solid var(--border)' }} onClick={() => onCambiar(p.valor ? p.valor.map(f => ({ ...f, dias: [...f.dias] })) : null)}>
            {p.etiqueta}
          </button>
        ))}
      </div>
      {franjas.length === 0 && <span className="texto-secundario"><Clock size={13} style={{ verticalAlign: -2 }} /> Sin restricción horaria: el permiso es válido las 24 horas, todos los días de su vigencia.</span>}
      {franjas.map((f, i) => (
        <div key={i} className="horario-franja">
          <div className="horario-dias" role="group" aria-label={`Días de la franja ${i + 1}`}>
            {DIAS.map((d, k) => (
              <button key={d} type="button" className={`horario-dia${f.dias.includes(k + 1) ? ' activo' : ''}`} disabled={deshabilitado}
                aria-pressed={f.dias.includes(k + 1)} title={NOMBRES[k]} onClick={() => alternarDia(i, k + 1)}>{d}</button>
            ))}
          </div>
          <input type="time" className="input horario-hora" value={f.desde} disabled={deshabilitado} aria-label="Desde"
            onChange={e => cambiar(i, { desde: e.target.value })} />
          <span className="texto-secundario">a</span>
          <input type="time" className="input horario-hora" value={f.hasta} disabled={deshabilitado} aria-label="Hasta"
            onChange={e => cambiar(i, { hasta: e.target.value })} />
          {f.hasta <= f.desde && HHMM.test(f.hasta) && <span className="insignia info">termina al día siguiente</span>}
          <button type="button" className="btn btn-ghost btn-sm btn-icono" onClick={() => quitar(i)} disabled={deshabilitado} aria-label="Quitar franja" title="Quitar franja">
            <Trash2 size={14} color="var(--alerta)" />
          </button>
        </div>
      ))}
      {franjas.length < 7 && (
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={deshabilitado}
          onClick={() => onCambiar([...franjas, { dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '17:00' }])}>
          <Plus size={14} /> Agregar franja
        </button>
      )}
      {!horarioValido(valor) && <span className="ayuda" style={{ color: 'var(--alerta)' }}>Cada franja necesita al menos un día y horas distintas.</span>}
    </div>
  );
};
