import { beforeEach, describe, expect, it, vi } from "vitest";
import { cuerpo, evento, ID_A, ID_B, ID_NUEVA, receta, tablaFalsa, tokenDe } from "./ayudas";

const tabla = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/clients", () => ({
  ddb: tabla,
  TABLE: "recetas",
  USUARIOS_TABLE: "usuarios",
  LIKES_TABLE: "likes",
  FAVORITOS_TABLE: "favoritos",
  INDICE_RECETA_ID: "recetaId-index",
  INDICE_ACTOR_KEY: "actorKey-index",
}));

import { handler as actualizar } from "../src/handlers/actualizar";
import { handler as crear } from "../src/handlers/crear";
import { handler as eliminar } from "../src/handlers/eliminar";
import { handler as imagenFirma } from "../src/handlers/imagenFirma";
import { handler as listar } from "../src/handlers/listar";
import { handler as obtener } from "../src/handlers/obtener";

const ana = tokenDe("ana");
const beto = tokenDe("beto");
const URL_A = `https://res.cloudinary.com/demo/image/upload/v1/recetario/recetas/${ID_A}.jpg`;
const cuerpoValido = {
  titulo: "Sopa",
  categoria: "comida",
  tiempoMinutos: 20,
  porciones: 2,
  ingredientes: [{ nombre: "Agua" }],
  pasos: ["Hervir"],
};

let fake: ReturnType<typeof tablaFalsa>;
const fetchFalso = vi.fn();

beforeEach(() => {
  process.env.JWT_SECRET = "una-clave-de-prueba-de-al-menos-32-caracteres";
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "clave-publica";
  process.env.CLOUDINARY_API_SECRET = "secreto";
  fake = tablaFalsa([
    receta({ userId: "ana", recetaId: ID_A, imagenUrl: URL_A, imagenPublicId: `recetario/recetas/${ID_A}` }),
    receta({ userId: "beto", recetaId: ID_B, titulo: "Tacos" }),
  ]);
  tabla.send.mockImplementation(fake.send);
  fetchFalso.mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchFalso);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("lectura pública", () => {
  it("el catálogo se puede ver sin token y trae las recetas de todos", async () => {
    const r = await listar(evento({}));
    expect(r).toMatchObject({ statusCode: 200 });
    const { recetas } = cuerpo(r as { body: string });
    expect(recetas).toHaveLength(2);
    expect(recetas.every((x: { esPropia: boolean }) => x.esPropia === false)).toBe(true);
    expect(JSON.stringify(recetas)).not.toContain("userId");
  });

  it("con token marca esPropia solo en las recetas del usuario", async () => {
    const { recetas } = cuerpo((await listar(evento({ token: ana }))) as { body: string });
    expect(recetas.find((x: { recetaId: string }) => x.recetaId === ID_A).esPropia).toBe(true);
    expect(recetas.find((x: { recetaId: string }) => x.recetaId === ID_B).esPropia).toBe(false);
  });

  it("un token vencido o inválido no bloquea al visitante", async () => {
    const r = await listar(evento({ token: "basura.basura.basura" }));
    expect(r).toMatchObject({ statusCode: 200 });
  });

  it("'Mis recetas' exige token y solo trae las propias", async () => {
    expect(await listar(evento({ query: { mias: "true" } }))).toMatchObject({ statusCode: 401 });
    const { recetas } = cuerpo((await listar(evento({ token: ana, query: { mias: "true" } }))) as { body: string });
    expect(recetas.map((x: { recetaId: string }) => x.recetaId)).toEqual([ID_A]);
  });

  it("el detalle es público y no expone al autor", async () => {
    const r = await obtener(evento({ id: ID_B }));
    expect(r).toMatchObject({ statusCode: 200 });
    const c = cuerpo(r as { body: string });
    expect(c).toMatchObject({ titulo: "Tacos", esPropia: false, imagenUrl: null });
    expect(c.userId).toBeUndefined();
  });

  it("el detalle indica esPropia al dueño y 404 si no existe", async () => {
    expect(cuerpo((await obtener(evento({ id: ID_A, token: ana }))) as { body: string }).esPropia).toBe(true);
    expect(await obtener(evento({ id: ID_NUEVA }))).toMatchObject({ statusCode: 404 });
  });
});

describe("crear", () => {
  it("exige token", async () => {
    expect(await crear(evento({ body: cuerpoValido }))).toMatchObject({ statusCode: 401 });
  });

  it("guarda la receta a nombre del usuario del token y la hace pública", async () => {
    const r = await crear(evento({ token: beto, body: cuerpoValido }));
    expect(r).toMatchObject({ statusCode: 201 });
    expect(cuerpo(r as { body: string }).esPropia).toBe(true);
    expect(fake.items.at(-1)?.userId).toBe("beto");
    const catalogo = cuerpo((await listar(evento({}))) as { body: string }).recetas;
    expect(catalogo).toHaveLength(3);
  });

  it("no acepta un id que ya existe, ni de otro usuario", async () => {
    const r = await crear(evento({ token: beto, body: { ...cuerpoValido, recetaId: ID_A } }));
    expect(r).toMatchObject({ statusCode: 409 });
  });

  it("ignora la foto y likesCount enviados al crear", async () => {
    const r = await crear(
      evento({
        token: ana,
        body: {
          ...cuerpoValido,
          recetaId: ID_NUEVA,
          likesCount: 999,
          imagenUrl: "https://x.com/a.jpg",
          imagenPublicId: "x",
        },
      }),
    );
    expect(fake.items.at(-1)?.imagenUrl).toBeUndefined();
    expect(fake.items.at(-1)?.likesCount).toBe(0);
    expect(cuerpo(r as { body: string }).likesCount).toBe(0);
  });
});

describe("propiedad al editar", () => {
  it("exige token", async () => {
    expect(await actualizar(evento({ id: ID_A, body: cuerpoValido }))).toMatchObject({ statusCode: 401 });
  });

  it("404 si no existe y 403 si es de otro, sin modificar nada", async () => {
    expect(await actualizar(evento({ id: ID_NUEVA, token: ana, body: cuerpoValido }))).toMatchObject({ statusCode: 404 });
    const r = await actualizar(evento({ id: ID_A, token: beto, body: cuerpoValido }));
    expect(r).toMatchObject({ statusCode: 403 });
    expect(fake.items.find((i) => i.recetaId === ID_A)?.titulo).toBe("Pastel");
  });

  it("el dueño edita, conserva la foto, preserva likesCount y no sobrescribe favorita histórica", async () => {
    const original = fake.items.find((i) => i.recetaId === ID_A)!;
    original.likesCount = 17;
    original.favorita = true;

    const r = await actualizar(evento({ id: ID_A, token: ana, body: { ...cuerpoValido, likesCount: 9999 } }));
    expect(r).toMatchObject({ statusCode: 200 });
    expect(cuerpo(r as { body: string })).toMatchObject({
      titulo: "Sopa",
      imagenUrl: URL_A,
      likesCount: 17,
      favorita: true,
    });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("guarda una foto válida de su receta", async () => {
    const url = `https://res.cloudinary.com/demo/image/upload/v9/recetario/recetas/${ID_B}.jpg`;
    const r = await actualizar(
      evento({ id: ID_B, token: beto, body: { ...cuerpoValido, imagenUrl: url, imagenPublicId: `recetario/recetas/${ID_B}` } }),
    );
    expect(r).toMatchObject({ statusCode: 200 });
    expect(cuerpo(r as { body: string }).imagenUrl).toBe(url);
  });

  it("rechaza la foto de otra receta o enviada a medias", async () => {
    const ajena = { ...cuerpoValido, imagenUrl: URL_A, imagenPublicId: `recetario/recetas/${ID_A}` };
    expect(await actualizar(evento({ id: ID_B, token: beto, body: ajena }))).toMatchObject({ statusCode: 400 });
    const mitad = { ...cuerpoValido, imagenUrl: URL_A };
    expect(await actualizar(evento({ id: ID_A, token: ana, body: mitad }))).toMatchObject({ statusCode: 400 });
  });

  it("al quitar la foto la borra en Cloudinary", async () => {
    const r = await actualizar(evento({ id: ID_A, token: ana, body: { ...cuerpoValido, imagenUrl: null, imagenPublicId: null } }));
    expect(cuerpo(r as { body: string }).imagenUrl).toBeNull();
    expect(fetchFalso).toHaveBeenCalledOnce();
    expect(String(fetchFalso.mock.calls[0]?.[0])).toContain("/image/destroy");
  });
});

describe("propiedad al eliminar", () => {
  it("exige token, 404 si no existe y 403 si es de otro", async () => {
    expect(await eliminar(evento({ id: ID_A }))).toMatchObject({ statusCode: 401 });
    expect(await eliminar(evento({ id: ID_NUEVA, token: ana }))).toMatchObject({ statusCode: 404 });
    expect(await eliminar(evento({ id: ID_A, token: beto }))).toMatchObject({ statusCode: 403 });
    expect(fake.items).toHaveLength(2);
  });

  it("el dueño la elimina, sin afectar otras, y se borra su foto", async () => {
    expect(await eliminar(evento({ id: ID_A, token: ana }))).toMatchObject({ statusCode: 204 });
    expect(fake.items.map((i) => i.recetaId)).toEqual([ID_B]);
    expect(String(fetchFalso.mock.calls[0]?.[0])).toContain("/image/destroy");
  });

  it("si falla el borrado de la foto, la receta igual se elimina", async () => {
    fetchFalso.mockResolvedValue({ ok: false, status: 500 });
    expect(await eliminar(evento({ id: ID_A, token: ana }))).toMatchObject({ statusCode: 204 });
  });
});

describe("firma de imagen", () => {
  it("exige token y que la receta sea del usuario", async () => {
    expect(await imagenFirma(evento({ id: ID_A }))).toMatchObject({ statusCode: 401 });
    expect(await imagenFirma(evento({ id: ID_NUEVA, token: ana }))).toMatchObject({ statusCode: 404 });
    expect(await imagenFirma(evento({ id: ID_A, token: beto }))).toMatchObject({ statusCode: 403 });
  });

  it("al dueño le entrega la firma sin el secreto", async () => {
    const r = await imagenFirma(evento({ id: ID_A, token: ana }));
    expect(r).toMatchObject({ statusCode: 200 });
    const c = cuerpo(r as { body: string });
    expect(c.publicId).toBe(`recetario/recetas/${ID_A}`);
    expect(c.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(c)).not.toContain("secreto");
  });
});
