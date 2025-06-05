#!/usr/bin/env bun

import * as core from "@actions/core";

type RetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
};

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 5000,
    maxDelayMs = 20000,
    backoffFactor = 2,
  } = options;

  let delayMs = initialDelayMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Attempt ${attempt} of ${maxAttempts}...`);
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Attempt ${attempt} failed:`, lastError.message);

      if (attempt < maxAttempts) {
        console.log(`Retrying in ${delayMs / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  console.error(`Operation failed after ${maxAttempts} attempts`);
  throw lastError;
}

async function getOidcToken(): Promise<string> {
  console.log(`🔧 [TOKEN] Attempting to get OIDC token with audience: claude-code-github-action`);
  
  try {
    const oidcToken = await core.getIDToken("claude-code-github-action");
    console.log(`🔧 [TOKEN] OIDC token obtained successfully: ${oidcToken.substring(0, 20)}...`);
    return oidcToken;
  } catch (error) {
    console.error("❌ [TOKEN] Failed to get OIDC token:", error);
    console.error("❌ [TOKEN] This usually means:");
    console.error("❌ [TOKEN] 1. Missing 'id-token: write' permission in workflow");
    console.error("❌ [TOKEN] 2. Running outside GitHub Actions environment");
    console.error("❌ [TOKEN] 3. GitHub Actions OIDC provider configuration issue");
    throw new Error(
      "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
    );
  }
}

async function exchangeForAppToken(oidcToken: string): Promise<string> {
  console.log(`🔧 [TOKEN] Exchanging OIDC token for GitHub App token`);
  console.log(`🔧 [TOKEN] OIDC token preview: ${oidcToken.substring(0, 20)}...`);
  
  const response = await fetch(
    "https://api.anthropic.com/api/github/github-app-token-exchange",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
      },
    },
  );

  console.log(`🔧 [TOKEN] Exchange response status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const responseJson = (await response.json()) as {
      error?: {
        message?: string;
      };
    };
    console.error(
      `❌ [TOKEN] App token exchange failed: ${response.status} ${response.statusText} - ${responseJson?.error?.message ?? "Unknown error"}`,
    );
    console.error(`❌ [TOKEN] This usually means:`);
    console.error(`❌ [TOKEN] 1. OIDC token is invalid or expired`);
    console.error(`❌ [TOKEN] 2. GitHub repository is not authorized for Claude Code`);
    console.error(`❌ [TOKEN] 3. Anthropic's token exchange service is down`);
    throw new Error(`${responseJson?.error?.message ?? "Unknown error"}`);
  }

  const appTokenData = (await response.json()) as {
    token?: string;
    app_token?: string;
  };
  const appToken = appTokenData.token || appTokenData.app_token;
  
  console.log(`🔧 [TOKEN] Response data keys: ${Object.keys(appTokenData).join(', ')}`);

  if (!appToken) {
    console.error(`❌ [TOKEN] App token not found in response`);
    console.error(`❌ [TOKEN] Response data:`, appTokenData);
    throw new Error("App token not found in response");
  }

  console.log(`🔧 [TOKEN] App token obtained successfully: ${appToken.substring(0, 8)}...`);
  return appToken;
}

export async function setupGitHubToken(): Promise<string> {
  console.log(`🔧 [TOKEN] Starting GitHub token setup`);
  console.log(`🔧 [TOKEN] Environment variables:`);
  console.log(`🔧 [TOKEN] - GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? process.env.GITHUB_TOKEN.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`🔧 [TOKEN] - OVERRIDE_GITHUB_TOKEN: ${process.env.OVERRIDE_GITHUB_TOKEN ? process.env.OVERRIDE_GITHUB_TOKEN.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`🔧 [TOKEN] - GITHUB_REPOSITORY: ${process.env.GITHUB_REPOSITORY || 'NOT SET'}`);
  console.log(`🔧 [TOKEN] - GITHUB_ACTIONS: ${process.env.GITHUB_ACTIONS || 'NOT SET'}`);
  console.log(`🔧 [TOKEN] - ACTIONS_ID_TOKEN_REQUEST_URL: ${process.env.ACTIONS_ID_TOKEN_REQUEST_URL ? 'SET' : 'NOT SET'}`);
  console.log(`🔧 [TOKEN] - ACTIONS_ID_TOKEN_REQUEST_TOKEN: ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ? 'SET' : 'NOT SET'}`);
  
  try {
    // Check if GitHub token was provided as override
    const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;

    if (providedToken) {
      console.log("🔧 [TOKEN] Using provided GITHUB_TOKEN for authentication");
      core.setOutput("GITHUB_TOKEN", providedToken);
      return providedToken;
    }

    console.log("Requesting OIDC token...");
    const oidcToken = await retryWithBackoff(() => getOidcToken());
    console.log("OIDC token successfully obtained");

    console.log("Exchanging OIDC token for app token...");
    const appToken = await retryWithBackoff(() =>
      exchangeForAppToken(oidcToken),
    );
    console.log("App token successfully obtained");

    console.log("Using GITHUB_TOKEN from OIDC");
    core.setOutput("GITHUB_TOKEN", appToken);
    return appToken;
  } catch (error) {
    core.setFailed(
      `Failed to setup GitHub token: ${error}.\n\nIf you instead wish to use this action with a custom GitHub token or custom GitHub app, provide a \`github_token\` in the \`uses\` section of the app in your workflow yml file.`,
    );
    process.exit(1);
  }
}
