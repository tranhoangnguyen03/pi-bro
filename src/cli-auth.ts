/** The shell chooses CLI account profiles. Bro only enforces the choice in each child. */
export type CliAuthBackend = "claude" | "codex";
export type CliChildAuth = { env: NodeJS.ProcessEnv; subscription: boolean };

// Launchers select an existing CLI profile via CLAUDE_CONFIG_DIR or CODEX_HOME.
// These source flags carry intent; Bro does not persist accounts or copy tokens.
export function resolveCliChildAuth(backend: CliAuthBackend, parent: NodeJS.ProcessEnv = process.env): CliChildAuth {
  const selector = backend === "claude" ? "PI_BRO_CLAUDE_AUTH_SOURCE" : "PI_BRO_CODEX_AUTH_SOURCE";
  const choice = parent[selector] ?? "inherit";
  if (choice !== "inherit" && choice !== "subscription")
    throw new Error("Invalid " + selector + "=" + JSON.stringify(choice) + "; use inherit or subscription.");
  const env = { ...parent };
  delete env.PI_BRO_CLAUDE_AUTH_SOURCE;
  delete env.PI_BRO_CODEX_AUTH_SOURCE;
  if (choice === "subscription") {
    if (backend === "claude") {
      // Claude -p gives API keys precedence over an authenticated subscription.
      for (const key of [
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
      ]) delete env[key];
    } else {
      // Codex exec has independent, documented API-key overrides.
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
      // A subscription request must not inherit a provider URL redirect.
      delete env.OPENAI_BASE_URL;
      delete env.CHATGPT_BASE_URL;
    }
  }
  return { env, subscription: choice === "subscription" };
}

/** Method-only status check. Does not prove a specific account or successful model request. */
export function isSubscriptionStatus(backend: CliAuthBackend, stdout: string): boolean {
  if (backend === "codex") return /^Logged in using ChatGPT\s*$/im.test(stdout.trim());
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>;
    return status?.loggedIn === true && status.authMethod === "claude.ai";
  } catch { return false; }
}


/**
 * Codex login status describes the account, not the effective request provider.
 * Read Codex's own resolved config via app-server config/read rather than
 * interpreting individual TOML layers in Bro.
 *
 * Only the built-in OpenAI provider with no endpoint override is admitted for
 * explicit ChatGPT subscription intent. Never silently switch the user's
 * configured custom provider to OpenAI. Other providers remain available in
 * ordinary (inherit) mode.
 */
export function codexSubscriptionRouteProblem(config: unknown): string | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config))
    return "Codex did not provide a usable effective configuration";
  const effective = config as Record<string, unknown>;
  // Codex 0.165.0 config/read reports null for an omitted provider.
  // Its own Config::load resolves that implicit default to "openai" *after*
  // managed, CLI and merged file/profile overrides. The app-server query
  // already uses those effective layers for the requested working directory.
  const configured = effective.model_provider;
  const provider = configured === null || configured === undefined ? "openai" : configured;
  if (provider !== "openai")
    return `Codex selected model_provider=${JSON.stringify(provider)}; choose the built-in OpenAI provider in the selected CODEX_HOME profile`;
  if (effective.openai_base_url !== undefined &&
      effective.openai_base_url !== null && effective.openai_base_url !== "")
    return "Codex has a custom openai_base_url; remove this redirect from the selected subscription profile";
  // Codex config/read includes its built-in ChatGPT URL even in an untouched
  // profile. Only an alternate target is a redirect.
  const chatgptUrl = effective.chatgpt_base_url;
  if (chatgptUrl !== undefined && chatgptUrl !== null && chatgptUrl !== "" &&
      (typeof chatgptUrl !== "string" ||
       chatgptUrl.replace(/[/]+$/, "") !== "https://chatgpt.com/backend-api"))
    return "Codex has a custom chatgpt_base_url; remove this redirect from the selected subscription profile";
  const providers = effective.model_providers;
  if (providers !== null && providers !== undefined) {
    if (typeof providers !== "object" || Array.isArray(providers))
      return "Codex returned an unreadable provider table";
    if (Object.prototype.hasOwnProperty.call(providers, "openai"))
      return "Codex overrides the built-in OpenAI provider; use an unmodified subscription provider";
  }
  return undefined;
}
