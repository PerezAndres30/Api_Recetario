import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BUCKET, s3 } from "./clients";
import { HttpError } from "./http";
import type { Receta } from "./schema";

export const EXTENSIONES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

const SEGUNDOS_LECTURA = 3600;

/** Asegura que la key pertenezca al usuario y tenga el formato que genera /imagen-url. */
export function validarImagenKey(userId: string, key: string): void {
  const prefijo = `usuarios/${userId}/recetas/`;
  const resto = key.startsWith(prefijo) ? key.slice(prefijo.length) : "";
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(resto)) {
    throw new HttpError(400, "imagenKey inválida");
  }
}

export function urlLectura(key: string): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: SEGUNDOS_LECTURA,
  });
}

export async function borrarImagen(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/** Convierte el registro de DynamoDB en la respuesta pública (con URL de lectura de la foto). */
export async function aRespuesta(receta: Receta) {
  const { userId: _userId, tituloBusqueda: _busqueda, ...publico } = receta;
  return {
    ...publico,
    imagenUrl: receta.imagenKey ? await urlLectura(receta.imagenKey) : null,
  };
}
