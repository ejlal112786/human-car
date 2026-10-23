# Asset sources and licenses

## Quaternius CC0 additions (October 2026)

The models listed below are by Quaternius and were obtained from the linked packs/pages. Quaternius publishes these packs under the **Creative Commons CC0 1.0 Universal** dedication. The assets may be used, modified, and redistributed without attribution; attribution is recorded here for provenance. See the individual archive/readme for any pack-specific notices.

| Pack | Source | Workspace archive | Models converted to GLB and currently referenced |
|---|---|---|---|
| Ultimate Textured Building Pack | [OpenGameArt](https://opengameart.org/content/lowpoly-buildings-pack) | `assets-src/quaternius/buildings/ultimate_textured_building_pack_by_quaternius.zip` | `src/assets/quaternius/1story.glb`, `2story_balcony.glb`, `3story_slim.glb`, `4story.glb`, `6story_stack.glb` |
| Low Poly Cars / Car Pack | [OpenGameArt](https://opengameart.org/content/lowpoly-cars) | `assets-src/quaternius/cars/Car_Pack.zip` | `basiccar.glb`, `copcar.glb`, `racecar.glb`, `taxi.glb`, `simplecarhigh.glb` |
| Low Poly Public Transport | [OpenGameArt](https://opengameart.org/content/lowpoly-public-transport) | `assets-src/quaternius/public-transport/Public_Transport.zip` | `bicycle.glb`, `bus.glb`, `ambulance.glb` |
| Low Poly Modular Street Pack | [OpenGameArt](https://opengameart.org/content/lowpoly-modular-street-pack) | `assets-src/quaternius/streets/Street_Pack.zip` | `sign_stop.glb`, `sign_noparking.glb`, `streetlight_single.glb`, `streetlight_double.glb` |
| Low Poly Guns | [Quaternius itch.io page](https://quaternius.itch.io/50-lowpoly-guns) | Existing source: `assets-src/quaternius-ultimate-gun-pack/` | Existing pistol source files; not part of this conversion batch |

### Runtime integration status

- The five converted building GLBs replace a stable sample of existing building footprints; the rest of the skyline remains procedural. Three themed districts—Portside, Market District, and Old Quarter—share the existing road loop and use different building-height/color profiles. These are districts in one world, **not three separate selectable city maps**.
- `basiccar.glb`, `taxi.glb`, and `simplecarhigh.glb` now render ambient traffic cars, with one Quaternius bus in the traffic pool. Existing traffic logic handles their movement, intimidation, and theft. Five parked curbside cars plus a bus and ambulance are also placed in the world.
- Stop/no-parking signs and single/double streetlights are placed along the road loop.
- Five NPC cyclists ride a loop on the roadside, are represented to the traffic simulation as moving road users, and slow when cars enter their buffer. Bicycles use the Quaternius bicycle GLB; rider bodies are simple instanced low-poly meshes.
- Three building doors open walkable, furnished shop/workshop/townhouse rooms. These rooms are staged off-map and entered/exited through paired prompts; they are not seamless interiors embedded inside every building.

The converted race-car and police-car models are used as parked scenery, not as player-owned vehicle catalog meshes. The separate-city maps and seamless building-interior system remain future work.

### Conversion notes

Selected OBJ/MTL assets from the pack archives were converted to binary glTF (`.glb`) for runtime loading. Source archives are retained under `assets-src/quaternius/`; converted runtime models are under `src/assets/quaternius/`. Conversion does not change the source license. See `assets-src/quaternius/` for original archives.
