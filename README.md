# Port Vesper

An original open-world crime-sandbox parody in the browser (Three.js), starring your scanned avatar.

```bash
npm install
npm run dev     # dev server
npm run build   # static site in dist/ (relative paths, host anywhere)
```

## Controls
WASD move/drive · Mouse look · Shift sprint · Space jump/handbrake · F enter/steal/exit car ·
LMB punch/shoot · RMB aim · 1/2/Q weapons · R radio · E horn/wave · C crouch (siren in a cop car) ·
V camera distance · Tab map · M mute · Esc pause

Cheats (type while playing): TOPUP, PAYDAY, COOLDOWN, HEATWAVE, ARSENAL, SUPERCAR, SUNSET, NIGHTOWL, HIGHNOON

## What's in it
- Procedural city: beach strip with pier and pastel hotels, downtown towers, midtown shops, Eastside, Palm Hills suburbs, park, hospital, police station, gas station, parking lot.
- Traffic that follows lanes and traffic lights, parked cars, carjacking, arcade driving with drifting, ramps/stunts, crashes, smoke, fire and explosions.
- Pedestrians that walk the sidewalks, cross streets, flee, fight back and get knocked down.
- 5-star wanted system: police cars chase, officers deploy, arrest you at low levels and shoot at higher ones.
- Fists and a carbine, pickups (cash, health, armor, ammo), 4 scripted jobs, day/night cycle, minimap with GPS route, full map.
- Three original generative radio stations (all synthesized in WebAudio; no audio files).

## Assets
- Player: your avatar (`player.glb` from floor-is-lava), Mixamo rig.
- Extra animations (driving, entering/exiting cars, punches, kick, rifle aim/fire/carry): Mixamo clips from the MIT-licensed kirbycope/godot-3d-player-controller, converted with `tools/fbx2clips.mjs`.
- NPC models: Xbot, Michelle, Soldier from the three.js examples (Mixamo characters); player clips are retargeted onto them at load (`src/retarget.js`).
- Models are shipped as self-contained glTF JSON (`tools/glb2json.mjs`) so static hosts that don't serve .glb still work.
