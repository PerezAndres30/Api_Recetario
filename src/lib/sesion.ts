import { crearToken } from "./jwt";
import type { ResultadoMigracionLikes } from "./likes";

/** Usuario tal como se guarda en DynamoDB (tabla de usuarios, clave: correo). */
export interface UsuarioGuardado {
  correo: string;
  usuarioId: string;
  nombre: string;
  passwordHash: string;
  creadaEn: string;
}

export interface MigracionLikesResumen {
  intentada: boolean;
  completada: boolean;
  migrados: number;
  deduplicados: number;
  bloqueadaPorOtraCuenta: boolean;
  parcial: boolean;
}

/** Contrato que consume la app: { token, usuario, migracionLikes? }. Nunca incluye la contraseña. */
export function aSesion(
  u: UsuarioGuardado,
  migracion?: { intento: boolean; resultado: ResultadoMigracionLikes | null },
) {
  const base = {
    token: crearToken(u.usuarioId),
    usuario: { id: u.usuarioId, nombre: u.nombre, correo: u.correo },
  };
  if (!migracion?.intento) return base;

  const r = migracion.resultado;
  const completada = r !== null && !r.parcial && !r.bloqueadaPorOtraCuenta;
  const resumen: MigracionLikesResumen = {
    intentada: true,
    completada,
    migrados: r?.migrados ?? 0,
    deduplicados: r?.deduplicados ?? 0,
    bloqueadaPorOtraCuenta: r?.bloqueadaPorOtraCuenta ?? false,
    parcial: r === null || r.parcial,
  };
  return { ...base, migracionLikes: resumen };
}
