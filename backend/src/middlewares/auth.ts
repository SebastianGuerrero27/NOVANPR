import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Sin valor por defecto: un secreto conocido permitiría falsificar tokens de administrador.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET no está definido. Configúrelo en backend/.env o en el .env de docker compose.');
}
export const JWT_SECRET: string = process.env.JWT_SECRET;

export interface UserPayload {
  id: number;
  username: string;
  nombre: string;
  rol: 'Admin' | 'Operador';
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acceso no autorizado. Token no provisto.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserPayload;
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido o expirado.' });
  }
}

export function roleMiddleware(roles: ('Admin' | 'Operador')[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Acceso no autorizado.' });
    }

    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Acceso denegado. Permisos insuficientes.' });
    }

    next();
  };
}
