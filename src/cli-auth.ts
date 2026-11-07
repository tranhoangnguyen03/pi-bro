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
