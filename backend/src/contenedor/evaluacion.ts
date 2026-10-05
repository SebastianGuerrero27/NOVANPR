import { casosEvaluacion } from '../aplicacion/evaluacion';
import { repositorioEvaluacionSql } from '../infraestructura/persistencia/evaluacionSql';

/** Raíz de composición de la evaluación del sistema: pasos vehiculares en SQL Server. */
export const evaluacion = casosEvaluacion({ repositorio: repositorioEvaluacionSql });
