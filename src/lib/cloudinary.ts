import { createHash } from "node:crypto";
import { HttpError } from "./http";

/** Formatos que Cloudinary acepta en las subidas firmadas por esta API. */
export const FORMATOS_PERMITIDOS = "jpg,png,webp";

function config() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary no está configurado");
  return { cloudName, apiKey, apiSecret };
}

/** Identificador fijo de la foto de una receta: una receta = una foto, y reemplazar sobrescribe. */
export const publicIdDe = (recetaId: string) => `recetario/recetas/${recetaId}`;

/**
 * Firma según Cloudinary: parámetros ordenados por nombre, unidos como nombre=valor con "&",
 * se añade el secreto al final y se aplica SHA-1. No se firman file, api_key, resource_type ni cloud_name.
 */
export function firmar(params: Record<string, string>, apiSecret: string): string {
  const texto = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(texto + apiSecret).digest("hex");
}

/** Datos que la app necesita para subir directo a Cloudinary la foto de esa receta. */
export function firmaSubida(recetaId: string, ahora = Math.floor(Date.now() / 1000)) {
  const { cloudName, apiKey, apiSecret } = config();
  const publicId = publicIdDe(recetaId);
  const timestamp = String(ahora);
  const signature = firmar(
    {
      allowed_formats: FORMATOS_PERMITIDOS,
      invalidate: "true",
      overwrite: "true",
      public_id: publicId,
      timestamp,
    },
    apiSecret,
  );
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    cloudName,
    apiKey,
    timestamp: ahora,
    signature,
    publicId,
    allowedFormats: FORMATOS_PERMITIDOS,
    overwrite: true,
    invalidate: true,
  };
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** La foto de una receta solo puede ser la que se subió con el identificador fijo, a nuestra cuenta. */
export function validarImagen(recetaId: string, imagenUrl: string, imagenPublicId: string): void {
  const esperado = publicIdDe(recetaId);
  if (imagenPublicId !== esperado) throw new HttpError(400, "imagenPublicId inválido");
  const { cloudName } = config();
  const patron = new RegExp(
    `^https://res\\.cloudinary\\.com/${escapar(cloudName)}/image/upload/(?:v\\d+/)?${escapar(esperado)}\\.(?:jpg|png|webp)$`,
  );
  if (!patron.test(imagenUrl)) throw new HttpError(400, "imagenUrl inválida");
}

/** Borra la imagen en Cloudinary (requiere el secreto, por eso solo lo hace el servidor). */
export async function borrarImagen(publicId: string): Promise<void> {
  const { cloudName, apiKey, apiSecret } = config();
  const params = {
    invalidate: "true",
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const body = new URLSearchParams({
    ...params,
    api_key: apiKey,
    signature: firmar(params, apiSecret),
  });
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: "POST",
    body,
  });
  if (!r.ok) throw new Error(`Cloudinary destroy respondió ${r.status}`);
}

/** Igual que borrarImagen, pero un fallo solo se registra: la receta ya cambió y no debe fallar por eso. */
export async function borrarImagenSegura(publicId: string | null | undefined): Promise<void> {
  if (!publicId) return;
  try {
    await borrarImagen(publicId);
  } catch (err) {
    console.error("No se pudo borrar la imagen en Cloudinary", publicId, err);
  }
}
