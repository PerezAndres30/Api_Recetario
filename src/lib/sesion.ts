import { crearToken } from "./jwt";

/** Usuario tal como se guarda en DynamoDB (tabla de usuarios, clave: correo). */
export interface UsuarioGuardado {
  correo: string;
  usuarioId: string;
  nombre: string;
  passwordHash: string;
  creadaEn: string;
}

/** Contrato que consume la app: { token, usuario }. Nunca incluye la contraseña. */
export function aSesion(u: UsuarioGuardado) {
  return {
    token: crearToken(u.usuarioId),
    usuario: { id: u.usuarioId, nombre: u.nombre, correo: u.correo },
  };
}
