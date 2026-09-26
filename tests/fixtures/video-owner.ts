// Bundler alias ONLY for the isolated HTTP ingestion harness. Never imported by app code.
export async function requireOwnerApi() { return { id: "video-harness-owner", role: "owner" }; }
