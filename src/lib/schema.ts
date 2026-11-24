import { z } from "zod";

const ingrediente = z.object({
  nombre: z.string().trim().min(1).max(100),
  // Texto libre para permitir "1/2", "al gusto", etc.
  cantidad: z.string().trim().max(30).default(""),
  unidad: z.string().trim().max(30).default(""),
});

/** Campos editables de una receta (cuerpo de POST y PUT). */
export const recetaInput = z.object({
  titulo: z.string().trim().min(1).max(120),
  descripcion: z.string().trim().max(1000).default(""),
  categoria: z.string().trim().min(1).max(40).default("otro"),
  tiempoMinutos: z.number().int().min(0).max(100000).default(0),
  porciones: z.number().int().min(1).max(1000).default(1),
  ingredientes: z.array(ingrediente).min(1).max(100),
  pasos: z.array(z.string().trim().min(1).max(2000)).min(1).max(100),
  favorita: z.boolean().default(false),
});

/** En POST el cliente puede mandar su propio UUID (útil para modo offline). */
export const crearInput = recetaInput.extend({
  recetaId: z.string().uuid().optional(),
});

/**
 * En PUT la foto es opcional: si faltan ambos campos se conserva la actual; si vienen los dos
 * (los que devuelve Cloudinary tras la subida) se valida y se guarda; con null se quita.
 */
export const actualizarInput = recetaInput.extend({
  imagenUrl: z.string().max(500).nullable().optional(),
  imagenPublicId: z.string().max(200).nullable().optional(),
});

/** Cómo se guarda una receta en DynamoDB. */
export type Receta = z.output<typeof recetaInput> & {
  userId: string;
  recetaId: string;
  imagenUrl?: string | null;
  imagenPublicId?: string | null;
  tituloBusqueda: string; // título en minúsculas, para filtrar con contains()
  creadaEn: string;
  actualizadaEn: string;
};

/**
 * Convierte el registro de DynamoDB en la respuesta pública: no expone el id del usuario,
 * pero indica con esPropia si la receta es de quien hace la petición (null = visitante).
 */
export function aRespuesta(receta: Receta, solicitanteId: string | null) {
  const { userId, tituloBusqueda: _busqueda, imagenUrl, imagenPublicId, ...publico } = receta;
  return {
    ...publico,
    imagenUrl: imagenUrl ?? null,
    imagenPublicId: imagenPublicId ?? null,
    esPropia: solicitanteId !== null && userId === solicitanteId,
  };
}

// ------------------------------------------------------------------ Auth
export const registroInput = z.object({
  nombre: z.string().trim().min(1, "El nombre es obligatorio").max(100),
  correo: z.string().trim().toLowerCase().email("El correo no es válido").max(254),
  password: z
    .string()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .max(128, "La contraseña es demasiado larga"),
});

export const loginInput = z.object({
  correo: z.string().trim().toLowerCase().email("El correo no es válido"),
  password: z.string().min(1, "La contraseña es obligatoria"),
});
