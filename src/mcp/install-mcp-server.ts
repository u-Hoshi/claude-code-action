import * as core from "@actions/core";

export async function prepareMcpConfig(
  githubToken: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  console.log(`🔧 [MCP] Preparing MCP config for ${owner}/${repo}:${branch}`);
  console.log(`🔧 [MCP] GitHub token available: ${githubToken ? githubToken.substring(0, 8) + '...' : 'MISSING'}`);
  console.log(`🔧 [MCP] Action path: ${process.env.GITHUB_ACTION_PATH}`);
  console.log(`🔧 [MCP] Workspace: ${process.env.GITHUB_WORKSPACE || process.cwd()}`);
  
  try {
    const mcpConfig = {
      mcpServers: {
        // githubサーバーは削除（Dockerが必要なため）
        // 代わりにgithub_file_opsですべての機能を提供
        github_file_ops: {
          command: "bun",
          args: [
            "run",
            `${process.env.GITHUB_ACTION_PATH}/src/mcp/github-file-ops-server.ts`,
          ],
          env: {
            GITHUB_TOKEN: githubToken,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            BRANCH_NAME: branch,
            REPO_DIR: process.env.GITHUB_WORKSPACE || process.cwd(),
          },
        },
      },
    };

    return JSON.stringify(mcpConfig, null, 2);
  } catch (error) {
    core.setFailed(`Install MCP server failed with error: ${error}`);
    process.exit(1);
  }
}