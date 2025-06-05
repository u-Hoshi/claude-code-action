#!/usr/bin/env node
// GitHub File Operations MCP Server
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { join } from "path";
import fetch from "node-fetch";
import { GITHUB_API_URL } from "../github/api/config";

type GitHubRef = {
  object: {
    sha: string;
  };
};

type GitHubCommit = {
  tree: {
    sha: string;
  };
};

type GitHubTree = {
  sha: string;
};

type GitHubNewCommit = {
  sha: string;
  message: string;
  author: {
    name: string;
    date: string;
  };
};

// Get repository information from environment variables
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const BRANCH_NAME = process.env.BRANCH_NAME;
const REPO_DIR = process.env.REPO_DIR || process.cwd();

if (!REPO_OWNER || !REPO_NAME || !BRANCH_NAME) {
  console.error(
    "Error: REPO_OWNER, REPO_NAME, and BRANCH_NAME environment variables are required",
  );
  process.exit(1);
}

const server = new McpServer({
  name: "GitHub File Operations Server",
  version: "0.0.1",
});

// Commit files tool
server.tool(
  "commit_files",
  "Commit one or more files to a repository in a single commit (this will commit them atomically in the remote repository)",
  {
    files: z
      .array(z.string())
      .describe(
        'Array of file paths relative to repository root (e.g. ["src/main.js", "README.md"]). All files must exist locally.',
      ),
    message: z.string().describe("Commit message"),
  },
  async ({ files, message }) => {
    const owner = REPO_OWNER;
    const repo = REPO_NAME;
    const branch = BRANCH_NAME;
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const processedFiles = files.map((filePath) => {
        if (filePath.startsWith("/")) {
          return filePath.slice(1);
        }
        return filePath;
      });

      // 1. Get the branch reference
      const refUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs/heads/${branch}`;
      const refResponse = await fetch(refUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!refResponse.ok) {
        throw new Error(
          `Failed to get branch reference: ${refResponse.status}`,
        );
      }

      const refData = (await refResponse.json()) as GitHubRef;
      const baseSha = refData.object.sha;

      // 2. Get the base commit
      const commitUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits/${baseSha}`;
      const commitResponse = await fetch(commitUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!commitResponse.ok) {
        throw new Error(`Failed to get base commit: ${commitResponse.status}`);
      }

      const commitData = (await commitResponse.json()) as GitHubCommit;
      const baseTreeSha = commitData.tree.sha;

      // 3. Create tree entries for all files
      const treeEntries = await Promise.all(
        processedFiles.map(async (filePath) => {
          const fullPath = filePath.startsWith("/")
            ? filePath
            : join(REPO_DIR, filePath);

          const content = await readFile(fullPath, "utf-8");
          return {
            path: filePath,
            mode: "100644",
            type: "blob",
            content: content,
          };
        }),
      );

      // 4. Create a new tree
      const treeUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/trees`;
      const treeResponse = await fetch(treeUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeEntries,
        }),
      });

      if (!treeResponse.ok) {
        const errorText = await treeResponse.text();
        throw new Error(
          `Failed to create tree: ${treeResponse.status} - ${errorText}`,
        );
      }

      const treeData = (await treeResponse.json()) as GitHubTree;

      // 5. Create a new commit
      const newCommitUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits`;
      const newCommitResponse = await fetch(newCommitUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: message,
          tree: treeData.sha,
          parents: [baseSha],
        }),
      });

      if (!newCommitResponse.ok) {
        const errorText = await newCommitResponse.text();
        throw new Error(
          `Failed to create commit: ${newCommitResponse.status} - ${errorText}`,
        );
      }

      const newCommitData = (await newCommitResponse.json()) as GitHubNewCommit;

      // 6. Update the reference to point to the new commit
      const updateRefUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs/heads/${branch}`;
      const updateRefResponse = await fetch(updateRefUrl, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sha: newCommitData.sha,
          force: false,
        }),
      });

      if (!updateRefResponse.ok) {
        const errorText = await updateRefResponse.text();
        throw new Error(
          `Failed to update reference: ${updateRefResponse.status} - ${errorText}`,
        );
      }

      const simplifiedResult = {
        commit: {
          sha: newCommitData.sha,
          message: newCommitData.message,
          author: newCommitData.author.name,
          date: newCommitData.author.date,
        },
        files: processedFiles.map((path) => ({ path })),
        tree: {
          sha: treeData.sha,
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simplifiedResult, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// Delete files tool
server.tool(
  "delete_files",
  "Delete one or more files from a repository in a single commit",
  {
    paths: z
      .array(z.string())
      .describe(
        'Array of file paths to delete relative to repository root (e.g. ["src/old-file.js", "docs/deprecated.md"])',
      ),
    message: z.string().describe("Commit message"),
  },
  async ({ paths, message }) => {
    const owner = REPO_OWNER;
    const repo = REPO_NAME;
    const branch = BRANCH_NAME;
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      // Convert absolute paths to relative if they match CWD
      const cwd = process.cwd();
      const processedPaths = paths.map((filePath) => {
        if (filePath.startsWith("/")) {
          if (filePath.startsWith(cwd)) {
            // Strip CWD from absolute path
            return filePath.slice(cwd.length + 1);
          } else {
            throw new Error(
              `Path '${filePath}' must be relative to repository root or within current working directory`,
            );
          }
        }
        return filePath;
      });

      // 1. Get the branch reference
      const refUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs/heads/${branch}`;
      const refResponse = await fetch(refUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!refResponse.ok) {
        throw new Error(
          `Failed to get branch reference: ${refResponse.status}`,
        );
      }

      const refData = (await refResponse.json()) as GitHubRef;
      const baseSha = refData.object.sha;

      // 2. Get the base commit
      const commitUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits/${baseSha}`;
      const commitResponse = await fetch(commitUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!commitResponse.ok) {
        throw new Error(`Failed to get base commit: ${commitResponse.status}`);
      }

      const commitData = (await commitResponse.json()) as GitHubCommit;
      const baseTreeSha = commitData.tree.sha;

      // 3. Create tree entries for file deletions (setting SHA to null)
      const treeEntries = processedPaths.map((path) => ({
        path: path,
        mode: "100644",
        type: "blob" as const,
        sha: null,
      }));

      // 4. Create a new tree with deletions
      const treeUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/trees`;
      const treeResponse = await fetch(treeUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeEntries,
        }),
      });

      if (!treeResponse.ok) {
        const errorText = await treeResponse.text();
        throw new Error(
          `Failed to create tree: ${treeResponse.status} - ${errorText}`,
        );
      }

      const treeData = (await treeResponse.json()) as GitHubTree;

      // 5. Create a new commit
      const newCommitUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/commits`;
      const newCommitResponse = await fetch(newCommitUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: message,
          tree: treeData.sha,
          parents: [baseSha],
        }),
      });

      if (!newCommitResponse.ok) {
        const errorText = await newCommitResponse.text();
        throw new Error(
          `Failed to create commit: ${newCommitResponse.status} - ${errorText}`,
        );
      }

      const newCommitData = (await newCommitResponse.json()) as GitHubNewCommit;

      // 6. Update the reference to point to the new commit
      const updateRefUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/git/refs/heads/${branch}`;
      const updateRefResponse = await fetch(updateRefUrl, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sha: newCommitData.sha,
          force: false,
        }),
      });

      if (!updateRefResponse.ok) {
        const errorText = await updateRefResponse.text();
        throw new Error(
          `Failed to update reference: ${updateRefResponse.status} - ${errorText}`,
        );
      }

      const simplifiedResult = {
        commit: {
          sha: newCommitData.sha,
          message: newCommitData.message,
          author: newCommitData.author.name,
          date: newCommitData.author.date,
        },
        deletedFiles: processedPaths.map((path) => ({ path })),
        tree: {
          sha: treeData.sha,
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simplifiedResult, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// Create issue tool - 新規追加！
server.tool(
  "create_issue",
  "Create a new issue in a GitHub repository",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Issue title"),
    body: z.string().describe("Issue body/description"),
    assignees: z.array(z.string()).optional().describe("Array of usernames to assign"),
    labels: z.array(z.string()).optional().describe("Array of label names"),
    milestone: z.number().optional().describe("Milestone number")
  },
  async ({ owner, repo, title, body, assignees, labels, milestone }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const createUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/issues`;
      const requestBody: any = {
        title,
        body
      };
      
      if (assignees) requestBody.assignees = assignees;
      if (labels) requestBody.labels = labels;
      if (milestone) requestBody.milestone = milestone;

      const response = await fetch(createUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to create issue: ${response.status} - ${errorText}`,
        );
      }

      const result = await response.json();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: result.id,
              number: result.number,
              title: result.title,
              state: result.state,
              html_url: result.html_url,
              created_at: result.created_at
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// Update issue comment tool - 新規追加！
server.tool(
  "github__update_issue_comment",
  "Update a GitHub issue comment",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    commentId: z.string().describe("Comment ID to update"),
    body: z.string().describe("New comment body"),
  },
  async ({ owner, repo, commentId, body }) => {
    console.log(`🔧 [MCP] Attempting to update issue comment: ${commentId}`);
    console.log(`🔧 [MCP] Repository: ${owner}/${repo}`);
    console.log(`🔧 [MCP] Comment body length: ${body.length} chars`);
    
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        console.error(`❌ [MCP] GITHUB_TOKEN environment variable is missing`);
        throw new Error("GITHUB_TOKEN environment variable is required");
      }
      
      console.log(`🔧 [MCP] GitHub token available: ${githubToken.substring(0, 8)}...`);

      const updateUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/issues/comments/${commentId}`;
      console.log(`🔧 [MCP] API URL: ${updateUrl}`);
      
      const requestHeaders = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };
      
      console.log(`🔧 [MCP] Request headers: ${JSON.stringify({...requestHeaders, Authorization: "Bearer [REDACTED]"})}`);
      
      const response = await fetch(updateUrl, {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({ body }),
      });

      console.log(`🔧 [MCP] Response status: ${response.status} ${response.statusText}`);
      console.log(`🔧 [MCP] Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [MCP] API Error: ${response.status} - ${errorText}`);
        
        // Add specific error messages for common permission issues
        if (response.status === 401) {
          console.error(`❌ [MCP] Authentication failed - check if GITHUB_TOKEN is valid and not expired`);
        } else if (response.status === 403) {
          console.error(`❌ [MCP] Permission denied - check if token has 'issues:write' or 'repo' scope`);
        } else if (response.status === 404) {
          console.error(`❌ [MCP] Comment or repository not found - verify comment ID ${commentId} exists in ${owner}/${repo}`);
        }
        
        throw new Error(
          `Failed to update comment: ${response.status} - ${errorText}`,
        );
      }

      const result = await response.json();
      console.log(`✅ [MCP] Comment updated successfully: ${commentId}`);
      
      return {
        content: [
          {
            type: "text",
            text: `Comment ${commentId} updated successfully`,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ [MCP] Error updating issue comment: ${errorMessage}`);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// Create pull request tool - 新規追加！
server.tool(
  "create_pull_request",
  "Create a new pull request in a GitHub repository",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Pull request title"),
    body: z.string().describe("Pull request body/description"),
    head: z.string().describe("The name of the branch where your changes are implemented"),
    base: z.string().describe("The name of the branch you want the changes pulled into"),
    draft: z.boolean().optional().describe("Whether to create the pull request as a draft"),
    maintainer_can_modify: z.boolean().optional().describe("Whether maintainers can modify the pull request")
  },
  async ({ owner, repo, title, body, head, base, draft, maintainer_can_modify }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      const createUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/pulls`;
      const requestBody: any = {
        title,
        body,
        head,
        base
      };
      
      if (draft !== undefined) requestBody.draft = draft;
      if (maintainer_can_modify !== undefined) requestBody.maintainer_can_modify = maintainer_can_modify;

      const response = await fetch(createUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to create pull request: ${response.status} - ${errorText}`,
        );
      }

      const result = await response.json();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: result.id,
              number: result.number,
              title: result.title,
              state: result.state,
              html_url: result.html_url,
              head: result.head.ref,
              base: result.base.ref,
              created_at: result.created_at
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// Update pull request comment tool - 新規追加！
server.tool(
  "github__update_pull_request_comment",
  "Update a GitHub pull request comment (for regular PR comments, not review comments)",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    commentId: z.string().describe("Comment ID to update"),
    body: z.string().describe("New comment body"),
  },
  async ({ owner, repo, commentId, body }) => {
    console.log(`🔧 [MCP] Attempting to update PR comment: ${commentId}`);
    console.log(`🔧 [MCP] Repository: ${owner}/${repo}`);
    console.log(`🔧 [MCP] Comment body length: ${body.length} chars`);
    
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        console.error(`❌ [MCP] GITHUB_TOKEN environment variable is missing`);
        throw new Error("GITHUB_TOKEN environment variable is required");
      }
      
      console.log(`🔧 [MCP] GitHub token available: ${githubToken.substring(0, 8)}...`);

      // PR comments use the same API as issue comments
      const updateUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/issues/comments/${commentId}`;
      console.log(`🔧 [MCP] API URL: ${updateUrl}`);
      
      const requestHeaders = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };
      
      console.log(`🔧 [MCP] Request headers: ${JSON.stringify({...requestHeaders, Authorization: "Bearer [REDACTED]"})}`);
      
      const response = await fetch(updateUrl, {
        method: "PATCH",
        headers: requestHeaders,
        body: JSON.stringify({ body }),
      });

      console.log(`🔧 [MCP] Response status: ${response.status} ${response.statusText}`);
      console.log(`🔧 [MCP] Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [MCP] API Error: ${response.status} - ${errorText}`);
        
        // Add specific error messages for common permission issues
        if (response.status === 401) {
          console.error(`❌ [MCP] Authentication failed - check if GITHUB_TOKEN is valid and not expired`);
        } else if (response.status === 403) {
          console.error(`❌ [MCP] Permission denied - check if token has 'issues:write' or 'repo' scope`);
        } else if (response.status === 404) {
          console.error(`❌ [MCP] Comment or repository not found - verify comment ID ${commentId} exists in ${owner}/${repo}`);
        }
        
        throw new Error(
          `Failed to update PR comment: ${response.status} - ${errorText}`,
        );
      }

      const result = await response.json();
      console.log(`✅ [MCP] PR comment updated successfully: ${commentId}`);
      
      return {
        content: [
          {
            type: "text",
            text: `PR comment ${commentId} updated successfully`,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ [MCP] Error updating PR comment: ${errorMessage}`);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// Update pull request review comment tool - 新規追加！
server.tool(
  "update_pull_request_review_comment",
  "Update a GitHub pull request review comment (for inline code review comments)",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    commentId: z.string().describe("Review comment ID to update"),
    body: z.string().describe("New comment body"),
  },
  async ({ owner, repo, commentId, body }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      // Review comments use a different API endpoint
      const updateUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/pulls/comments/${commentId}`;
      const response = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to update PR review comment: ${response.status} - ${errorText}`,
        );
      }

      const result = await response.json();
      
      return {
        content: [
          {
            type: "text",
            text: `PR review comment ${commentId} updated successfully`,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

// List issues tool - 新規追加！
server.tool(
  "list_issues",
  "List issues in a GitHub repository",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    state: z.enum(["open", "closed", "all"]).optional().describe("Issue state filter"),
    labels: z.string().optional().describe("Comma-separated list of label names"),
    assignee: z.string().optional().describe("Filter by assignee username"),
    creator: z.string().optional().describe("Filter by creator username"),
    sort: z.enum(["created", "updated", "comments"]).optional().describe("Sort order"),
    direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    per_page: z.number().optional().describe("Number of results per page (max 100)"),
    page: z.number().optional().describe("Page number")
  },
  async ({ owner, repo, state, labels, assignee, creator, sort, direction, per_page, page }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }

      // Build query parameters
      const params = new URLSearchParams();
      if (state) params.append("state", state);
      if (labels) params.append("labels", labels);
      if (assignee) params.append("assignee", assignee);
      if (creator) params.append("creator", creator);
      if (sort) params.append("sort", sort);
      if (direction) params.append("direction", direction);
      if (per_page) params.append("per_page", per_page.toString());
      if (page) params.append("page", page.toString());

      const listUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/issues?${params.toString()}`;
      const response = await fetch(listUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to list issues: ${response.status} - ${errorText}`,
        );
      }

      const issues = await response.json();
      
      // Simplify the response
      const simplifiedIssues = issues.map((issue: any) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        html_url: issue.html_url,
        user: issue.user.login,
        labels: issue.labels.map((label: any) => label.name),
        assignees: issue.assignees.map((assignee: any) => assignee.login),
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        comments: issue.comments
      }));
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(simplifiedIssues, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Log environment variables for debugging permission issues
  console.error("🚀 [MCP] GitHub File Operations Server started");
  console.error(`🔧 [MCP] REPO_OWNER: ${REPO_OWNER}`);
  console.error(`🔧 [MCP] REPO_NAME: ${REPO_NAME}`);
  console.error(`🔧 [MCP] BRANCH_NAME: ${BRANCH_NAME}`);
  console.error(`🔧 [MCP] REPO_DIR: ${REPO_DIR}`);
  console.error(`🔧 [MCP] GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? `${process.env.GITHUB_TOKEN.substring(0, 8)}...` : 'NOT SET'}`);
  console.error(`🔧 [MCP] Working directory: ${process.cwd()}`);
  console.error(`🔧 [MCP] Node version: ${process.version}`);
  console.error(`🔧 [MCP] Platform: ${process.platform}`);
  
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch(console.error);