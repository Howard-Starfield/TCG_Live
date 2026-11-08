# Game artwork defaults

User-supplied tournament GIFs are copied unchanged into:

```text
games/
  one-piece/
    gifs/tournament.gif
    thumbnails/.gitkeep
  one-punch-man/
    gifs/tournament.gif
    thumbnails/.gitkeep
  pokemon/
    gifs/tournament.gif
    thumbnails/.gitkeep
```

Sources: `Luffy’s One Piece Tournament Punch.gif`, `one_punch_man_tournament.gif`, and `Pokémon Tournament_ Electrifying Throwaway.gif`. Copies were SHA-256 verified against the supplied files. These are user-provided assets, separate from the original status-orb artwork under `assets/discord/`.

Dashboard upload/preview/reset controls and runtime game-specific visual selection are queued, not implemented by this asset copy. Thumbnail slots are intentionally empty until images are supplied or selected. Existing status artwork remains the running bot's fallback. Adding game artwork does not add a new tournament rules engine.
