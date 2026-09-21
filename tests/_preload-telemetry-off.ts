// Loaded by bunfig.toml before every test file. Hook subprocesses spread
// process.env, so this also disables telemetry in every hook the suite spawns.
process.env.VERCEL_PLUGIN_TELEMETRY = "off";
