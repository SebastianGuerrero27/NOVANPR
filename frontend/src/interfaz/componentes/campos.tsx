import React, { useEffect, useState } from 'react';
import {
  type ReglaTexto, errorDe, esPrefijoPlaca, filtrarTexto, formatearPlacaParcial, LARGO_PLACA, normalizarPlaca,
  soloDigitos, validarEntero, validarFecha, validarPlaca, validarTexto,
} from '../../dominio/validacion';

/**
 * Controles de formulario con las reglas de lib/validacion.ts (espejo de backend/src/dominio/validacion.ts).
 *
 * Mientras se escribe bloquean los caracteres que la regla no admite y limitan la longitud. El
 * error aparece junto al campo (aria-invalid + aria-describedby) al salir de él o en cuanto lo
 * escrito ya no puede llegar a ser válido; un valor precargado (edición, lectura de la cámara)
 * muestra su error de inmediato. El formulario calcula con los mismos validadores si habilita el
 * botón de envío, y la API vuelve a validar: su mensaje de error se muestra siempre.
 */

interface Comunes {
  id: string;
  etiqueta?: React.ReactNode;
  ayuda?: React.ReactNode;
  className?: string;
  autoFocus?: boolean;
  deshabilitado?: boolean;
  placeholder?: string;
  /** Enter en el campo (p. ej. enviar si el formulario es válido) */
  onEnter?: () => void;
}

type Control = HTMLInputElement | HTMLTextAreaElement;

/** Etiqueta, control y, debajo, el error visible o la ayuda. */
const Marco: React.FC<{ id: string; etiqueta?: React.ReactNode; className?: string; error: string | null; ayuda?: React.ReactNode; children: React.ReactNode }> =
  ({ id, etiqueta, className, error, ayuda, children }) => (
    <div className={`campo${className ? ` ${className}` : ''}`}>
      {etiqueta && <label htmlFor={id}>{etiqueta}</label>}
      {children}
      {error
        ? <span id={`${id}-error`} className="error">{error}</span>
        : ayuda ? <span id={`${id}-ayuda`} className="ayuda">{ayuda}</span> : null}
    </div>
  );

/** aria-invalid y aria-describedby según haya un error visible o una ayuda. */
const describir = (id: string, error: string | null, ayuda: React.ReactNode) => ({
  'aria-invalid': error ? true : undefined,
  'aria-describedby': error ? `${id}-error` : ayuda ? `${id}-ayuda` : undefined,
});

const alPresionarEnter = (onEnter?: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); }
};

/** Durante una composición (tilde con tecla muerta, teclado del celular) no se transforma lo escrito. */
const componiendo = (e: React.SyntheticEvent) => Boolean((e.nativeEvent as InputEvent).isComposing);

const clase = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);

/** Posición del cursor; null en los controles que no la tienen (type="email"). */
function cursorDe(el: Control): number | null {
  try { return el.selectionStart; } catch { return null; }
}

/**
 * Deja el cursor en `posicion` cuando React termina de reponer el valor controlado: sin esto, al
 * quitar o agregar caracteres el cursor salta al final del texto. En un cambio de texto React
 * actualiza el control al cerrar el evento; al pegar o al terminar una composición lo hace en una
 * microtarea, por eso se esperan dos (la segunda queda detrás de la de React).
 */
function ubicarCursor(el: Control, posicion: number) {
  queueMicrotask(() => queueMicrotask(() => {
    try { if (document.activeElement === el) el.setSelectionRange(posicion, posicion); } catch { /* control sin selección */ }
  }));
}

/**
 * Lo escrito con el filtro aplicado. Si el filtro quitó caracteres, el cursor queda tras lo
 * último que se escribió (lo que había antes del cursor, ya filtrado). Lo usan también los
 * controles con estilo propio (pantallas de acceso) y los buscadores.
 */
export function filtrarEscrito(el: Control, limpiar: (v: string) => string): string {
  const crudo = el.value;
  const limpio = limpiar(crudo);
  const cursor = cursorDe(el);
  if (limpio !== crudo && cursor !== null) ubicarCursor(el, limpiar(crudo.slice(0, cursor)).length);
  return limpio;
}

/** Posición del cursor después del carácter significativo número `n` del texto formateado. */
function posicionTras(texto: string, n: number): number {
  if (n <= 0) return 0;
  let vistos = 0;
  for (let i = 0; i < texto.length; i++) {
    if (/[A-Z0-9]/.test(texto[i])) vistos++;
    if (vistos === n) return i + 1;
  }
  return texto.length;
}

/**
 * Placa ingresada por una persona: mayúsculas, solo letras y números, máximo 7 caracteres
 * significativos. Se muestra con guion (ABC-1234 / AB-123C) pero el formulario recibe la placa
 * normalizada (ABC1234), que es lo que valida y guarda la API.
 */
export const CampoPlaca: React.FC<Comunes & { valor: string; onCambiar: (placa: string) => void; requerido?: boolean }> = ({
  id, etiqueta, ayuda = 'Automóvil ABC-1234 · motocicleta AB-123C', className, autoFocus, deshabilitado, placeholder = 'ABC-1234',
  onEnter, valor, onCambiar, requerido = true,
}) => {
  const placa = normalizarPlaca(valor).slice(0, LARGO_PLACA);
  const [texto, setTexto] = useState(() => formatearPlacaParcial(placa));
  const [tocado, setTocado] = useState(() => placa !== '');

  // Valor que llega desde afuera (precarga, limpiar): el formulario queda con la placa normalizada
  // y el campo muestra lo mismo que se va a validar
  useEffect(() => {
    if (valor !== placa) onCambiar(placa);
    if (normalizarPlaca(texto).slice(0, LARGO_PLACA) !== placa) setTexto(formatearPlacaParcial(placa));
  }, [valor]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Normaliza lo escrito; el guion aparece o desaparece y el cursor sigue tras el mismo carácter. */
  const aplicar = (el: HTMLInputElement, crudo: string, cursor: number | null) => {
    const nueva = normalizarPlaca(crudo).slice(0, LARGO_PLACA);
    const formateado = formatearPlacaParcial(nueva);
    const cambiaControl = formateado !== el.value;
    setTexto(formateado);
    onCambiar(nueva);
    if (cambiaControl) ubicarCursor(el, posicionTras(formateado, normalizarPlaca(crudo.slice(0, cursor ?? crudo.length)).length));
  };
  const cambiar = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (componiendo(e)) { setTexto(e.target.value); onCambiar(normalizarPlaca(e.target.value).slice(0, LARGO_PLACA)); return; }
    aplicar(e.target, e.target.value, e.target.selectionStart);
  };
  // Lo pegado se normaliza antes de recortar: maxLength cortaría "PBA - 1234" en "PBA - 12"
  const pegar = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const pegado = e.clipboardData.getData('text');
    const inicio = el.selectionStart ?? el.value.length;
    const fin = el.selectionEnd ?? inicio;
    aplicar(el, el.value.slice(0, inicio) + pegado + el.value.slice(fin), inicio + pegado.length);
  };

  const error = !placa && !requerido ? null : errorDe(validarPlaca(placa));
  // Incompleta: se avisa al salir del campo; imposible de completar (p. ej. "1AB" o "ABCD123"): de inmediato
  const visible = error && (placa ? tocado || !esPrefijoPlaca(placa) : tocado) ? error : null;

  return (
    <Marco id={id} etiqueta={etiqueta} className={className} error={visible} ayuda={ayuda}>
      <input id={id} className="input placa-input" value={texto} onChange={cambiar} onPaste={pegar}
        onCompositionEnd={e => aplicar(e.currentTarget, e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => { setTocado(true); setTexto(formatearPlacaParcial(placa)); }} onKeyDown={alPresionarEnter(onEnter)}
        maxLength={LARGO_PLACA + 1} placeholder={placeholder} autoFocus={autoFocus} disabled={deshabilitado}
        autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false}
        aria-required={requerido || undefined} {...describir(id, visible, ayuda)} />
    </Marco>
  );
};

/**
 * Texto con su regla (tipo, longitud, obligatorio): bloquea al escribir los caracteres que el
 * tipo no admite y muestra el error de validarTexto al salir del campo.
 */
export const CampoTexto: React.FC<Comunes & {
  valor: string; onCambiar: (valor: string) => void; regla: ReglaTexto;
  /** Error calculado por el formulario (p. ej. el de un correo); por omisión, el de la regla */
  error?: string | null;
  /** Filtro de caracteres propio; por omisión, el del tipo de texto de la regla */
  filtrar?: (valor: string) => string;
  /** Texto literal (correo, URL, usuario, IP): sin corrector ni mayúscula automática */
  literal?: boolean;
  multilinea?: boolean; tipo?: 'text' | 'email'; autoComplete?: string; claseControl?: string;
}> = ({
  id, etiqueta, ayuda, className, autoFocus, deshabilitado, placeholder, onEnter,
  valor, onCambiar, regla, error, filtrar, literal, multilinea, tipo = 'text', autoComplete, claseControl,
}) => {
  const [tocado, setTocado] = useState(() => valor.trim() !== '');
  const mensaje = error !== undefined ? error : errorDe(validarTexto(valor, regla));
  const visible = tocado ? mensaje : null;
  const limpiar = filtrar ?? ((v: string) => filtrarTexto(v, regla.tipo));
  const sinCorrector = literal || tipo === 'email';
  const comunes = {
    id, value: valor, placeholder, autoFocus, disabled: deshabilitado, maxLength: regla.max,
    onChange: (e: React.ChangeEvent<Control>) => onCambiar(componiendo(e) ? e.target.value : filtrarEscrito(e.target, limpiar)),
    onCompositionEnd: (e: React.CompositionEvent<Control>) => onCambiar(filtrarEscrito(e.currentTarget, limpiar)),
    onBlur: () => setTocado(true),
    'aria-required': regla.requerido || undefined,
    ...(sinCorrector ? { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : {}),
    ...describir(id, visible, ayuda),
  };
  return (
    <Marco id={id} etiqueta={etiqueta} className={className} error={visible} ayuda={ayuda}>
      {multilinea
        ? <textarea className={clase('textarea', claseControl)} {...comunes} />
        : <input className={clase('input', claseControl)} type={tipo} autoComplete={autoComplete} onKeyDown={alPresionarEnter(onEnter)} {...comunes} />}
    </Marco>
  );
};

/**
 * Entero: solo admite dígitos (soloDigitos; teclado numérico en el celular) y valida el rango con
 * validarEntero. Pasarse del máximo se avisa de inmediato; el resto, al salir del campo.
 */
export const CampoEntero: React.FC<Comunes & {
  valor: string; onCambiar: (valor: string) => void;
  /** Nombre del dato en los mensajes de error */
  nombre: string;
  min?: number; max?: number; requerido?: boolean; error?: string | null; claseControl?: string;
}> = ({ id, etiqueta, ayuda, className, autoFocus, deshabilitado, placeholder, onEnter, valor, onCambiar, nombre, min, max, requerido, error, claseControl }) => {
  const [tocado, setTocado] = useState(() => valor !== '');
  const mensaje = error !== undefined ? error : errorDe(validarEntero(valor, { etiqueta: nombre, min, max, requerido }));
  const excede = max !== undefined && valor !== '' && Number(valor) > max;
  const visible = tocado || excede ? mensaje : null;
  // Tantos dígitos como el mayor valor admitido (65535 → 5)
  const digitos = String(Math.max(max ?? 999999999, min ?? 0)).length;
  return (
    <Marco id={id} etiqueta={etiqueta} className={className} error={visible} ayuda={ayuda}>
      <input id={id} className={clase('input', claseControl)} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
        value={valor} onChange={e => onCambiar(filtrarEscrito(e.target, v => soloDigitos(v).slice(0, digitos)))} onBlur={() => setTocado(true)}
        onKeyDown={alPresionarEnter(onEnter)} maxLength={digitos} placeholder={placeholder} autoFocus={autoFocus} disabled={deshabilitado}
        aria-required={requerido || undefined} {...describir(id, visible, ayuda)} />
    </Marco>
  );
};

/** Fecha AAAA-MM-DD (selector nativo) validada con validarFecha; `error` agrega reglas entre campos. */
export const CampoFecha: React.FC<Comunes & {
  valor: string; onCambiar: (valor: string) => void; nombre: string; requerido?: boolean; min?: string; max?: string; error?: string | null;
}> = ({ id, etiqueta, ayuda, className, autoFocus, deshabilitado, valor, onCambiar, nombre, requerido, min, max, error }) => {
  const visible = errorDe(validarFecha(valor, { etiqueta: nombre, requerido })) ?? error ?? null;
  return (
    <Marco id={id} etiqueta={etiqueta} className={className} error={visible} ayuda={ayuda}>
      <input id={id} type="date" className="input" value={valor} min={min} max={max} onChange={e => onCambiar(e.target.value)}
        autoFocus={autoFocus} disabled={deshabilitado} aria-required={requerido || undefined} {...describir(id, visible, ayuda)} />
    </Marco>
  );
};
