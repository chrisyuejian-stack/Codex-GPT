import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
export async function historicalDatabase(until) {
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir("migrations")).sort())
    if (Number(name.slice(0, 4)) <= until)
      db.exec(await readFile("migrations/" + name, "utf8"));
  return db;
}
