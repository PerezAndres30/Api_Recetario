import { eliminarFavoritosDeReceta } from "./favoritos";
import {
  eliminarLikesDeReceta,
  LIMPIEZA_PENDIENTE_ACTOR_KEY,
  registrarLimpiezaPendiente,
} from "./likes";
import { buscarReceta } from "./recetas";
import type { OpcionesReintentoBatch } from "./dynamo";

export interface ResultadoLimpiezaRelaciones {
  likesEliminados: number;
  favoritosEliminados: number;
  parcial: boolean;
}

/**
 * Limpia de forma paginada las relaciones en LikesTable y FavoritosTable tras eliminar una receta.
 * Nota de consistencia eventual: FavoritosTable usa el GSI recetaId-index (eventualmente consistente);
 * si un favorito escrito justo antes de eliminar aún no apareciera en el índice, GET /favoritos lo
 * filtra y depura automáticamente al hidratar. Ante fallos parciales registra un marcador pendiente.
 */
export async function limpiarRelacionesDeReceta(
  recetaId: string,
  opciones?: OpcionesReintentoBatch,
): Promise<ResultadoLimpiezaRelaciones> {
  const [resLikes, resFavs] = await Promise.allSettled([
    eliminarLikesDeReceta(recetaId, opciones),
    eliminarFavoritosDeReceta(recetaId, opciones),
  ]);

  const falloLikes = resLikes.status === "rejected";
  const falloFavs = resFavs.status === "rejected";

  if (falloLikes) {
    console.error(`Fallo parcial al limpiar likes de receta ${recetaId}:`, resLikes.reason);
  }
  if (falloFavs) {
    console.error(`Fallo parcial al limpiar favoritos de receta ${recetaId}:`, resFavs.reason);
  }

  const parcial = falloLikes || falloFavs;
  if (parcial) {
    try {
      await registrarLimpiezaPendiente(recetaId);
    } catch (err) {
      console.error(`No se pudo registrar marcador pendiente (${LIMPIEZA_PENDIENTE_ACTOR_KEY}) para ${recetaId}:`, err);
    }
  }

  return {
    likesEliminados: resLikes.status === "fulfilled" ? resLikes.value : 0,
    favoritosEliminados: resFavs.status === "fulfilled" ? resFavs.value : 0,
    parcial,
  };
}

/**
 * Recupera limpiezas pendientes tras fallos parciales o demoras de replicación en GSI.
 * Solo actúa si la receta ya no existe en RecetasTable.
 */
export async function recuperarLimpiezaReceta(
  recetaId: string,
  opciones?: OpcionesReintentoBatch,
): Promise<ResultadoLimpiezaRelaciones> {
  const sigueExistiendo = await buscarReceta(recetaId);
  if (sigueExistiendo) {
    return { likesEliminados: 0, favoritosEliminados: 0, parcial: false };
  }

  const favoritosEliminados = await eliminarFavoritosDeReceta(recetaId, opciones);
  // Borrar al final los registros de LikesTable elimina también __LIMPIEZA_PENDIENTE__.
  const likesEliminados = await eliminarLikesDeReceta(recetaId, opciones);
  return { likesEliminados, favoritosEliminados, parcial: false };
}
