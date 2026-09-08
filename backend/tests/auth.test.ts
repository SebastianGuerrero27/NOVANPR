import jwt from 'jsonwebtoken';

const JWT_SECRET = 'ecu911_super_secret_token_key_2026';

interface UserPayload {
  id: number;
  username: string;
  nombre: string;
  rol: 'Admin' | 'Operador';
}

describe('Pruebas Unitarias de Autenticación JWT', () => {
  it('Debe generar un token JWT válido y desencriptarlo exitosamente', () => {
    const payload: UserPayload = {
      id: 1,
      username: 'operator',
      nombre: 'Operador Zona 3',
      rol: 'Operador'
    };

    // Generar token
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    // Verificar token
    const decoded = jwt.verify(token, JWT_SECRET) as UserPayload;
    expect(decoded.id).toBe(payload.id);
    expect(decoded.username).toBe(payload.username);
    expect(decoded.rol).toBe(payload.rol);
  });

  it('Debe fallar si el token es alterado o tiene una clave incorrecta', () => {
    const payload: UserPayload = {
      id: 2,
      username: 'admin',
      nombre: 'Administrador',
      rol: 'Admin'
    };

    const token = jwt.sign(payload, JWT_SECRET);
    const alteredToken = token + 'altered';

    expect(() => {
      jwt.verify(alteredToken, JWT_SECRET);
    }).toThrow();

    expect(() => {
      jwt.verify(token, 'clave_incorrecta');
    }).toThrow();
  });
});
