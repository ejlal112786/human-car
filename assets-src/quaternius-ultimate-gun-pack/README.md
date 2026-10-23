# Pistol model source

`Pistol_4.obj` / `Pistol_4.mtl` from **"Ultimate Gun Pack" by Quaternius** (July 2019 release),
licence **CC0 1.0 (public domain)**: no attribution required, commercial use allowed.

* Download used: https://opengameart.org/sites/default/files/ultimate_gun_pack_by_quaternius.zip
  (page: https://opengameart.org/content/low-poly-guns-pack, licence field CC0)
* Author page with the same licence: https://quaternius.itch.io/50-lowpoly-guns

`scripts/gen-pistol.py` converts the OBJ into `src/game/crime/pistolModel.ts` (metres, +Z = barrel,
+Y = up, origin at the top of the grip; the slide + sights are a separate part so they can cycle).
The game only ships the generated module, not the OBJ.
