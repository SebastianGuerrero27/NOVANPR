import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, KeyRound, Search, UserCog, X } from 'lucide-react';
import api from '../services/api';
import { useConsulta, useRetardado } from '../lib/hooks';
import type { Pagina } from '../lib/tipos';
import { fechaHora, limiteDia } from '../lib/formato';
import { Aviso, FilasEsqueleto, Paginacion, Pestanas, Tarjeta, Vacio } from '../components/ui';

type Fuente = 'operaciones' | 'cuentas' | 'accesos';

const MOTIVOS_ACCESO: Record<string, string> = {
  ok: 'Inicio de sesión correcto', credenciales: 'Contraseña incorrecta o correo inexistente', bloqueado: 'Cuenta bloqueada',
  bloqueo_por_intentos: 'Bloqueada por intentos fallidos', no_verificado: 'Correo sin verificar', inactivo: 'Cuenta inactiva',
};

const ENTIDADES: Record<string, string> = {
  deteccion: 'Ingreso', lista_negra: 'Lista de alertas', autorizado: 'Autorizados', camara: 'Cámara', configuracion: 'Configuración',
};

const legible = (accion: string) => accion.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());

const Auditoria: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const fuente = (['operaciones', 'cuentas', 'accesos'].includes(params.get('fuente') ?? '') ? params.get('fuente') : 'operaciones') as Fuente;
  const [texto, setTexto] = useState(params.get('q') ?? '');
  const q = useRetardado(texto, 400);
  const desde = params.get('desde') ?? '';
  const hasta = params.get('hasta') ?? '';
  const resultado = params.get('resultado') ?? '';
  const pagina = Number(params.get('pagina') ?? 1);

  const cambiar = (cambios: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(cambios)) { if (v) p.set(k, v); else p.delete(k); }
    if (!('pagina' in cambios)) p.delete('pagina');
    setParams(p, { replace: true });
  };
  React.useEffect(() => { if ((params.get('q') ?? '') !== q) cambiar({ q }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const consulta = useMemo(() => ({
    fuente, q: params.get('q') || undefined, resultado: resultado || undefined, pagina, tamano: 30,
    desde: desde ? limiteDia(desde) : undefined, hasta: hasta ? limiteDia(hasta, true) : undefined,
  }), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const { datos, cargando, error } = useConsulta<Pagina<any>>(() => api.get('/auditoria', { params: consulta }).then(r => r.data), [consulta]);
  const hayFiltros = Boolean(params.get('q') || desde || hasta || resultado);

  return (
    <div className="pagina">
      <div className="pila">
        <Pestanas<Fuente> valor={fuente} onCambiar={f => { setTexto(''); setParams({ fuente: f }, { replace: true }); }} opciones={[
          { valor: 'operaciones', etiqueta: 'Operaciones', icono: <Activity size={15} /> },
          { valor: 'cuentas', etiqueta: 'Cuentas de usuario', icono: <UserCog size={15} /> },
          { valor: 'accesos', etiqueta: 'Inicios de sesión', icono: <KeyRound size={15} /> },
        ]} />
        <Tarjeta>
          <div className="filtros">
            <div className="campo crece"><label htmlFor="a-q">Buscar</label>
              <div className="input-icono"><Search size={15} /><input id="a-q" className="input" value={texto} onChange={e => setTexto(e.target.value)}
                placeholder={fuente === 'accesos' ? 'Correo, motivo o IP' : 'Usuario, acción o detalle'} /></div></div>
            {fuente === 'accesos' && (
              <div className="campo"><label htmlFor="a-res">Resultado</label>
                <select id="a-res" className="select" value={resultado} onChange={e => cambiar({ resultado: e.target.value })}>
                  <option value="">Todos</option><option value="exito">Correctos</option><option value="fallo">Fallidos</option>
                </select></div>
            )}
            <div className="campo" style={{ minWidth: 140 }}><label htmlFor="a-desde">Desde</label>
              <input id="a-desde" type="date" className="input" value={desde} onChange={e => cambiar({ desde: e.target.value })} /></div>
            <div className="campo" style={{ minWidth: 140 }}><label htmlFor="a-hasta">Hasta</label>
              <input id="a-hasta" type="date" className="input" value={hasta} onChange={e => cambiar({ hasta: e.target.value })} /></div>
            {hayFiltros && <button className="btn btn-ghost" onClick={() => { setTexto(''); setParams({ fuente }, { replace: true }); }}><X size={15} /> Limpiar</button>}
          </div>
        </Tarjeta>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Tarjeta titulo={fuente === 'operaciones' ? 'Acciones sobre ingresos, listas, cámaras y configuración' : fuente === 'cuentas' ? 'Acciones sobre cuentas de usuario' : 'Intentos de inicio de sesión'}
          subtitulo="Registro inalterable desde la aplicación: no existe opción para editarlo ni borrarlo." sinPadding>
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead>
                {fuente === 'accesos'
                  ? <tr><th>Fecha</th><th>Correo</th><th>Resultado</th><th>IP</th><th className="ocultar-movil">Navegador</th></tr>
                  : <tr><th>Fecha</th><th>Usuario</th><th>Acción</th>{fuente === 'operaciones' ? <th>Elemento</th> : <th>Cuenta afectada</th>}<th>Detalle</th><th className="ocultar-movil">IP</th></tr>}
              </thead>
              <tbody>
                {cargando && !datos ? <FilasEsqueleto columnas={6} /> : datos?.items.map(x => fuente === 'accesos' ? (
                  <tr key={x.id}>
                    <td className="nowrap">{fechaHora(x.fecha)}</td><td>{x.email}</td>
                    <td><span className={`insignia ${x.exito ? 'autorizado' : 'alerta'}`}>{MOTIVOS_ACCESO[x.motivo] ?? x.motivo}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{x.ip || '—'}</td>
                    <td className="ocultar-movil truncar" style={{ maxWidth: 260 }} title={x.user_agent}>{x.user_agent || '—'}</td>
                  </tr>
                ) : (
                  <tr key={x.id}>
                    <td className="nowrap">{fechaHora(x.fecha)}</td><td>{x.actor ?? <span className="texto-secundario">sistema</span>}</td>
                    <td><strong style={{ color: 'var(--text)', fontWeight: 600 }}>{legible(x.accion)}</strong></td>
                    <td>{fuente === 'operaciones' ? <>{ENTIDADES[x.entidad] ?? x.entidad}{x.entidad_id ? <span className="secundario">#{x.entidad_id}</span> : null}</> : x.objetivo ?? '—'}</td>
                    <td style={{ maxWidth: 380 }}>{x.detalle ?? '—'}</td>
                    <td className="mono ocultar-movil" style={{ fontSize: 12 }}>{x.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {datos && datos.items.length === 0 && <Vacio titulo="Sin registros" texto={hayFiltros ? 'Ningún registro coincide con los filtros.' : 'Aún no hay eventos de este tipo.'} />}
          {datos && datos.total > 0 && <Paginacion pagina={datos.pagina} tamano={datos.tamano} total={datos.total} onCambiar={p => cambiar({ pagina: String(p) })} />}
        </Tarjeta>
      </div>
    </div>
  );
};

export default Auditoria;
