# Original TCG Live status artwork

These 12 trainer-orb designs were authored for this bot using geometric SVG shapes. No SysBot code or third-party sprite files were copied. The PNG/GIF outputs are packaged with the server; SVGs are editable source/reference artwork and are not uploaded to Discord.

All runtime assets are 96×96 pixels. Signup, check-in, setup, running, paused, proposal, final, reminder and notice use 12-frame looping GIFs. Disputed, expired and error use static PNGs. The clock-hand animation is decorative and never represents the saved match timer. Status text, colors and controls remain authoritative.

To regenerate with a development Python environment containing Pillow:

```text
python scripts/generate_discord_visuals.py
```

The bot itself needs neither Python nor Pillow. Asset paths resolve relative to the source/compiled module. `visual-contact-sheet.png` is the inspected overview; GIF playback depends on the Discord client's animation preferences. If the artwork changes, bump the `v1` filenames and matching visual catalog so existing cards get fresh files.

The state-to-embed-thumbnail pattern was studied in [DudeBot.NET](https://github.com/Havokx89/DudeBot.NET) and [Tradebot](https://github.com/jonklee99/Tradebot). Research and implementation boundaries are documented in [the visual plan](../../../../docs/DISCORD_VISUAL_PLAN.md).
