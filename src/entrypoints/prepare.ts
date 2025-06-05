#!/usr/bin/env bun

/**
 * Prepare the Claude action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkTriggerAction } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { checkWritePermissions } from "../github/validation/permissions";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { setupBranch } from "../github/operations/branch";
import { updateTrackingComment } from "../github/operations/comments/update-with-branch";
import { prepareMcpConfig } from "../mcp/install-mcp-server";
import { createPrompt } from "../create-prompt";
import { createOctokit } from "../github/api/client";
import { fetchGitHubData } from "../github/data/fetcher";
import { parseGitHubContext } from "../github/context";

async function run() {
  try {
    console.log(`🔧 [PREPARE] Starting Claude action preparation`);
    console.log(`🔧 [PREPARE] Event: ${process.env.GITHUB_EVENT_NAME}`);
    console.log(`🔧 [PREPARE] Repository: ${process.env.GITHUB_REPOSITORY}`);
    console.log(`🔧 [PREPARE] Actor: ${process.env.GITHUB_ACTOR}`);
    
    // Step 1: Setup GitHub token
    console.log(`🔧 [PREPARE] Setting up GitHub token...`);
    const githubToken = await setupGitHubToken();
    console.log(`🔧 [PREPARE] GitHub token obtained: ${githubToken.substring(0, 8)}...`);
    const octokit = createOctokit(githubToken);

    // Step 2: Parse GitHub context (once for all operations)
    console.log(`🔧 [PREPARE] Parsing GitHub context...`);
    const context = parseGitHubContext();
    console.log(`🔧 [PREPARE] Context parsed - Event: ${context.eventName}, Entity: ${context.entityNumber}`);

    // Step 3: Check write permissions
    console.log(`🔧 [PREPARE] Checking write permissions for ${context.repository.full_name}...`);
    const hasWritePermissions = await checkWritePermissions(
      octokit.rest,
      context,
    );
    if (!hasWritePermissions) {
      console.error(`❌ [PREPARE] Actor does not have write permissions to ${context.repository.full_name}`);
      throw new Error(
        "Actor does not have write permissions to the repository",
      );
    }
    console.log(`✅ [PREPARE] Write permissions confirmed`);

    // Step 4: Check trigger conditions
    const containsTrigger = await checkTriggerAction(context);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    // Step 5: Check if actor is human
    await checkHumanActor(octokit.rest, context);

    // Step 6: Create initial tracking comment
    const commentId = await createInitialComment(octokit.rest, context);

    // Step 7: Fetch GitHub data (once for both branch setup and prompt creation)
    const githubData = await fetchGitHubData({
      octokits: octokit,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
    });

    // Step 8: Setup branch
    const branchInfo = await setupBranch(octokit, githubData, context);

    // Step 9: Update initial comment with branch link (only for issues that created a new branch)
    if (branchInfo.claudeBranch) {
      await updateTrackingComment(
        octokit,
        context,
        commentId,
        branchInfo.claudeBranch,
      );
    }

    // Step 10: Create prompt file
    await createPrompt(
      commentId,
      branchInfo.defaultBranch,
      branchInfo.claudeBranch,
      githubData,
      context,
    );

    // Step 11: Get MCP configuration
    const mcpConfig = await prepareMcpConfig(
      githubToken,
      context.repository.owner,
      context.repository.repo,
      branchInfo.currentBranch,
    );
    core.setOutput("mcp_config", mcpConfig);
  } catch (error) {
    core.setFailed(`Prepare step failed with error: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
