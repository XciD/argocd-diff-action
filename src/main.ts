import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { exec, ExecException, ExecOptions } from 'child_process';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import nodeFetch from 'node-fetch';

interface ExecResult {
  err?: Error | undefined;
  stdout: string;
  stderr: string;
}

interface App {
  metadata: { name: string };
  spec: {
    source: {
      repoURL: string;
      path: string;
      targetRevision: string;
      kustomize: Object;
      helm: Object;
    };
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}
const ARCH = process.env.ARCH || 'linux';
const githubToken = core.getInput('github-token');
core.info(githubToken);

const ARGOCD_SERVER_URL = core.getInput('argocd-server-url');
const ARGOCD_TOKEN = core.getInput('argocd-token');
const VERSION = core.getInput('argocd-version');
const EXTRA_CLI_ARGS = core.getInput('argocd-extra-cli-args');

const octokit = github.getOctokit(githubToken);

async function execCommand(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const p = new Promise<ExecResult>(async (done, failed) => {
    exec(command, options, (err: ExecException | null, stdout: string, stderr: string): void => {
      const res: ExecResult = {
        stdout,
        stderr
      };
      if (err) {
        res.err = err;
        failed(res);
        return;
      }
      done(res);
    });
  });
  return await p;
}

function scrubSecrets(input: string): string {
  let output = input;
  const authTokenMatches = input.match(/--auth-token=([\w.\S]+)/);
  if (authTokenMatches) {
    output = output.replace(new RegExp(authTokenMatches[1], 'g'), '***');
  }
  return output;
}

async function setupArgoCDCommand(): Promise<(params: string) => Promise<ExecResult>> {
  const argoBinaryPath = 'bin/argo';
  await tc.downloadTool(
    `https://github.com/argoproj/argo-cd/releases/download/${VERSION}/argocd-${ARCH}-amd64`,
    argoBinaryPath
  );
  fs.chmodSync(path.join(argoBinaryPath), '755');

  // core.addPath(argoBinaryPath);

  return async (params: string) =>
    execCommand(
      `${argoBinaryPath} ${params} --auth-token=${ARGOCD_TOKEN} --server=${ARGOCD_SERVER_URL} ${EXTRA_CLI_ARGS}`,
      { env: { ...process.env, KUBECTL_EXTERNAL_DIFF: 'diff -N -u' } }
    );
}

async function getApps(): Promise<App[]> {
  const url = `https://${ARGOCD_SERVER_URL}/api/v1/applications?repo=https://github.com/${github.context.repo.owner}/${github.context.repo.repo}`;
  core.info(`Fetching apps from: ${url}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseJson: any;
  try {
    const response = await nodeFetch(url, {
      method: 'GET',
      headers: { Cookie: `argocd.token=${ARGOCD_TOKEN}` }
    });
    responseJson = await response.json();
  } catch (e: any) {
    core.error(e);
  }

  core.info(JSON.stringify(responseJson));

  return responseJson.items as App[];
}

interface Diff {
  app: App;
  diff: string;
  error?: ExecResult;
}

async function postDiffComments(diffs: Diff[]): Promise<void> {
  const { owner, repo } = github.context.repo;
  const issue_number = github.context.issue.number;
  const sha = github.context.payload.pull_request?.head?.sha;
  const shortCommitSha = String(sha).substring(0, 7);
  const commitLink = `https://github.com/${owner}/${repo}/pull/${issue_number}/commits/${sha}`;

  // Build individual diff blocks
  const diffBlocks = diffs.map(({ app, diff, error }) => {
    return scrubSecrets(`
App: [\`${app.metadata.name}\`](https://${ARGOCD_SERVER_URL}/applications/${app.metadata.name})
YAML generation: ${error ? "Error 🛑" : "Success 🟢"}
App sync status: ${
      app.status.sync.status === "Synced" ? "Synced ✅" : "Out of Sync ⚠️ "
    }
${error ? `
**\`stderr:\`**
\`\`\`
${error.stderr}
\`\`\`

**\`command:\`**
\`\`\`json
${JSON.stringify(error.err)}
\`\`\`
` : ""}
${diff ? `
<details>
\`\`\`diff
${diff}
\`\`\`
</details>
` : ""}
---
`);
  });

  // Header block (goes in comment #1) ----
  const headerBlock = scrubSecrets(`
## ArgoCD Diff for commit [\`${shortCommitSha}\`](${commitLink})
_Updated at ${new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" })} CEST_

| Legend | Status |
| :---:  | :---   |
| ✅     | The app is synced in ArgoCD, and diffs you see are solely from this PR. |
| ⚠️      | The app is out-of-sync in ArgoCD, and the diffs you see include those changes plus any from this PR. |
| 🛑     | There was an error generating the ArgoCD diffs due to changes in this PR. |
`);

  const MAX = 60000;

  // Split into several comments if too long (each < MAX chars) ----
  const commentsToPost: string[] = [];

  // First comment is only header + first few diffs until full
  {
    let block = headerBlock + "\n\n";
    for (const diffBlock of diffBlocks) {
      if (block.length + diffBlock.length > MAX) break;
      block += diffBlock + "\n";
    }
    commentsToPost.push(block);
  }

  // Remaining diffs (atomic chunks)
  {
    let current = "";
    for (const diffBlock of diffBlocks.slice(0).filter(b => !commentsToPost[0].includes(b))) {
      if (current.length + diffBlock.length > MAX) {
        commentsToPost.push(current);
        current = "";
      }
      current += diffBlock + "\n";
    }
    if (current.trim().length > 0) commentsToPost.push(current);
  }

  // List comments and only keep argo comments, ignore others
  const { data: existingComments } = await octokit.rest.issues.listComments({ owner, repo, issue_number });
  const argoComments = existingComments.filter(c => c.body?.includes("ArgoCD Diff for"));

  // Update or create comments, delete the extra previous ones
  for (let i = 0; i < commentsToPost.length; i++) {
    const body = commentsToPost[i];
    if (argoComments[i]) {
      // update existing
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: argoComments[i].id,
        body
      });
    } else {
      // create new
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body
      });
    }
  }

  // Delete extra stale ones
  for (let i = commentsToPost.length; i < argoComments.length; i++) {
    await octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: argoComments[i].id
    });
  }
}


async function asyncForEach<T>(
  array: T[],
  callback: (item: T, i: number, arr: T[]) => Promise<void>
): Promise<void> {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

async function run(): Promise<void> {
  const argocd = await setupArgoCDCommand();
  const apps = await getApps();
  core.info(`Found apps: ${apps.map(a => a.metadata.name).join(', ')}`);

  const diffs: Diff[] = [];

  await asyncForEach(apps, async app => {
    const command = `app diff ${app.metadata.name} --local=${app.spec.source.path}`;
    try {
      core.info(`Running: argocd ${command}`);
      // ArgoCD app diff will exit 1 if there is a diff, so always catch,
      // and then consider it a success if there's a diff in stdout
      // https://github.com/argoproj/argo-cd/issues/3588
      await argocd(command);
    } catch (e) {
      const res = e as ExecResult;
      core.info(`stdout: ${res.stdout}`);
      core.info(`stderr: ${res.stderr}`);
      if (res.stdout) {
        diffs.push({ app, diff: res.stdout });
      } else {
        diffs.push({
          app,
          diff: '',
          error: res
        });
      }
    }
  });
  try {
    await postDiffComments(diffs);
  } catch (e: any) {
    core.error(e);
  }
  const diffsWithErrors = diffs.filter(d => d.error);
  if (diffsWithErrors.length) {
    core.setFailed(`ArgoCD diff failed: Encountered ${diffsWithErrors.length} errors`);
  }
}

run().catch(e => core.setFailed(e.message));
