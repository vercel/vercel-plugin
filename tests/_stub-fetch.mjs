// `node --import ./tests/_stub-fetch.mjs <hook>` — swallow any outbound
// telemetry from a hook under test without touching the network.
globalThis.fetch = async () => new Response(null, { status: 204 });
