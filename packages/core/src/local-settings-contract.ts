// Local settings for the guided start (npm start), stored in the setup profile (data/discord-setup.json).
// GET/PUT /api/v1/settings/local. Precedence: a `1` in .env forces a setting on; otherwise the saved switch decides.

export interface LocalSettingsDto {
  /** "Allow dashboard actions": the session gets every capability TCG_ADMIN_COMMANDS=1 grants. */
  dashboardActions: {
    /** What sessions get now (re-evaluated on every request). */
    enabled: boolean;
    /** The saved switch. On by default; a profile without the field counts as on. */
    saved: boolean;
    /** TCG_ADMIN_COMMANDS=1 in .env or the shell: on regardless of the switch. */
    forcedByEnv: boolean;
  };
  /** Voice monitoring (helper voice bots, loudness flags, recording). Read when the bot starts. */
  voiceMonitoring: {
    /** The saved switch. Off by default. */
    saved: boolean;
    /** What the running bot uses; null while the bot has not started yet (first-start setup). */
    running: boolean | null;
    /** TCG_DISCORD_VOICE=1 in .env or the shell: on regardless of the switch. */
    forcedByEnv: boolean;
    /** The saved switch differs from the running bot; restart npm start to apply it. */
    restartRequired: boolean;
  };
}

/** PUT body: at least one field. */
export interface LocalSettingsPatchDto {
  dashboardActions?: boolean;
  voiceMonitoring?: boolean;
}

export const LOCAL_SETTINGS_AUDIT_KINDS = ['local.settings'] as const;
