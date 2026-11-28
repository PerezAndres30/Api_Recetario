import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { borrarImagenSegura, validarImagen } from "../lib/cloudinary";
import { ddb, TABLE } from "../lib/clients";
import { esRecetaFavorita } from "../lib/favoritos";
import { getRecetaId, getUserId, HttpError, json, parseBody, withErrors } from "../lib/http";
import { consultarLikesDeActor } from "../lib/likes";
import { buscarReceta, exigirPropietario } from "../lib/recetas";
import { aActorKeyUsuario, actualizarInput, aRespuesta, type Receta } from "../lib/schema";

// PUT /recetas/{id}  (solo el creador; preserva likesCount ante concurrencia y el campo histórica favorita si se omite)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);
  const { imagenUrl, imagenPublicId, ...campos } = parseBody(event, actualizarInput);

  const actual = exigirPropietario(await buscarReceta(recetaId), userId);

  // Foto: sin campos = se conserva; ambos null = se quita; ambos con valor = se valida y se guarda.
  let foto = { imagenUrl: actual.imagenUrl ?? null, imagenPublicId: actual.imagenPublicId ?? null };
  let imagenABorrar: string | null = null;
  if (imagenUrl === undefined && imagenPublicId === undefined) {
    // se conserva
  } else if (imagenUrl === null && imagenPublicId === null) {
    imagenABorrar = actual.imagenPublicId ?? null;
    foto = { imagenUrl: null, imagenPublicId: null };
  } else if (typeof imagenUrl === "string" && typeof imagenPublicId === "string") {
    validarImagen(recetaId, imagenUrl, imagenPublicId);
    foto = { imagenUrl, imagenPublicId };
  } else {
    throw new HttpError(400, "imagenUrl e imagenPublicId deben enviarse juntos");
  }

  const actualizadaEn = new Date().toISOString();
  const favoritaPreservada = campos.favorita ?? actual.favorita ?? false;

  let actualizada: Receta;
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { userId, recetaId },
        UpdateExpression:
          "SET titulo = :titulo, descripcion = :descripcion, categoria = :categoria, " +
          "tiempoMinutos = :tiempoMinutos, porciones = :porciones, ingredientes = :ingredientes, " +
          "pasos = :pasos, favorita = :favorita, imagenUrl = :imagenUrl, " +
          "imagenPublicId = :imagenPublicId, tituloBusqueda = :tituloBusqueda, " +
          "actualizadaEn = :actualizadaEn, likesCount = if_not_exists(likesCount, :cero)",
        ConditionExpression: "attribute_exists(recetaId)",
        ExpressionAttributeValues: {
          ":titulo": campos.titulo,
          ":descripcion": campos.descripcion,
          ":categoria": campos.categoria,
          ":tiempoMinutos": campos.tiempoMinutos,
          ":porciones": campos.porciones,
          ":ingredientes": campos.ingredientes,
          ":pasos": campos.pasos,
          ":favorita": favoritaPreservada,
          ":imagenUrl": foto.imagenUrl,
          ":imagenPublicId": foto.imagenPublicId,
          ":tituloBusqueda": campos.titulo.toLowerCase(),
          ":actualizadaEn": actualizadaEn,
          ":cero": 0,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    actualizada = (res.Attributes as Receta | undefined) ?? {
      ...actual,
      ...campos,
      ...foto,
      favorita: favoritaPreservada,
      tituloBusqueda: campos.titulo.toLowerCase(),
      actualizadaEn,
    };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(404, "Receta no encontrada");
    }
    throw err;
  }

  const [likedIds, esFavorito] = await Promise.all([
    consultarLikesDeActor([recetaId], aActorKeyUsuario(userId)),
    esRecetaFavorita(userId, recetaId),
  ]);

  await borrarImagenSegura(imagenABorrar);
  return json(
    200,
    aRespuesta(actualizada, userId, {
      leDiLike: likedIds.has(recetaId),
      esFavorito,
    }),
  );
});
