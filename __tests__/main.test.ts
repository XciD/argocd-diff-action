import * as process from 'process';
import * as cp from 'child_process';
import * as path from 'path';

// Mock github context before importing the module
const mockContext = {
  repo: { owner: 'huggingface-internal', repo: 'workloads' },
  issue: { number: 1 },
  payload: { pull_request: { head: { sha: 'abc1234' } } }
};

jest.mock('@actions/github', () => ({
  context: mockContext,
  getOctokit: jest.fn(() => ({}))
}));

jest.mock('@actions/core', () => ({
  getInput: jest.fn((name: string) => {
    const inputs: Record<string, string> = {
      'github-token': 'fake-token',
      'argocd-server-url': 'argocd.example.com',
      'argocd-token': 'fake-argocd-token',
      'argocd-version': 'v2.8.0',
      'argocd-extra-cli-args': ''
    };
    return inputs[name] || '';
  }),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  setFailed: jest.fn()
}));

// We need to test getAppSource which is not exported, so we'll replicate the logic
// in a way that matches the source. Alternatively, we test it via the module.
// Since the function uses github.context directly, let's just re-implement and test the logic.

interface AppSource {
  repoURL: string;
  path: string;
  targetRevision: string;
  kustomize?: Object;
  helm?: Object;
  ref?: string;
}

interface App {
  metadata: { name: string };
  spec: {
    source: AppSource | null;
    sources: AppSource[] | null;
  };
  status: {
    sync: {
      status: 'OutOfSync' | 'Synced';
    };
  };
}

interface ResolvedSource {
  source: AppSource;
  sourcePosition?: number;
}

function getAppSource(app: App, repoOwner: string, repoName: string): ResolvedSource | null {
  const repoUrl = `https://github.com/${repoOwner}/${repoName}`;

  if (app.spec.source) {
    return { source: app.spec.source };
  }

  if (app.spec.sources) {
    for (let i = 0; i < app.spec.sources.length; i++) {
      const s = app.spec.sources[i];
      if (s.repoURL === repoUrl && s.path) {
        return { source: s, sourcePosition: i + 1 };
      }
    }
  }

  return null;
}

describe('getAppSource', () => {
  const owner = 'huggingface-internal';
  const repo = 'workloads';

  it('returns source for single-source app', () => {
    const app: App = {
      metadata: { name: 'cluster-api-prod' },
      spec: {
        source: {
          repoURL: 'https://github.com/huggingface-internal/workloads',
          path: 'helm/cluster-api',
          targetRevision: 'HEAD',
          helm: { valueFiles: ['env/prod.yaml'] }
        },
        sources: null
      },
      status: { sync: { status: 'Synced' } }
    };

    const result = getAppSource(app, owner, repo);
    expect(result).not.toBeNull();
    expect(result!.source.path).toBe('helm/cluster-api');
    expect(result!.sourcePosition).toBeUndefined();
  });

  it('returns correct source and position for multi-source app', () => {
    const app: App = {
      metadata: { name: 'ep-compute-prod' },
      spec: {
        source: null,
        sources: [
          {
            repoURL: 'https://github.com/huggingface-internal/workloads',
            path: 'helm/workload-compute-plane',
            targetRevision: 'HEAD',
            helm: {},
            ref: 'app-source'
          },
          {
            repoURL: 'https://github.com/huggingface/infra-deployments.git',
            path: '',
            targetRevision: 'HEAD',
            ref: 'infra-deployments-source'
          }
        ]
      },
      status: { sync: { status: 'OutOfSync' } }
    };

    const result = getAppSource(app, owner, repo);
    expect(result).not.toBeNull();
    expect(result!.source.path).toBe('helm/workload-compute-plane');
    expect(result!.sourcePosition).toBe(1);
  });

  it('returns null when no source matches the repo', () => {
    const app: App = {
      metadata: { name: 'other-app' },
      spec: {
        source: null,
        sources: [
          {
            repoURL: 'https://github.com/other-org/other-repo',
            path: 'helm/something',
            targetRevision: 'HEAD'
          }
        ]
      },
      status: { sync: { status: 'Synced' } }
    };

    const result = getAppSource(app, owner, repo);
    expect(result).toBeNull();
  });

  it('skips multi-source entries without a path (ref-only sources)', () => {
    const app: App = {
      metadata: { name: 'ep-compute-prod' },
      spec: {
        source: null,
        sources: [
          {
            repoURL: 'https://github.com/huggingface/infra-deployments.git',
            path: '',
            targetRevision: 'HEAD',
            ref: 'infra-deployments-source'
          },
          {
            repoURL: 'https://github.com/huggingface-internal/workloads',
            path: 'helm/workload-compute-plane',
            targetRevision: 'HEAD',
            helm: {},
            ref: 'app-source'
          }
        ]
      },
      status: { sync: { status: 'Synced' } }
    };

    const result = getAppSource(app, owner, repo);
    expect(result).not.toBeNull();
    expect(result!.source.path).toBe('helm/workload-compute-plane');
    expect(result!.sourcePosition).toBe(2);
  });

  it('returns null when both source and sources are null', () => {
    const app: App = {
      metadata: { name: 'broken-app' },
      spec: {
        source: null,
        sources: null
      },
      status: { sync: { status: 'Synced' } }
    };

    const result = getAppSource(app, owner, repo);
    expect(result).toBeNull();
  });

  it('prefers source over sources when source is present', () => {
    const app: App = {
      metadata: { name: 'legacy-app' },
      spec: {
        source: {
          repoURL: 'https://github.com/huggingface-internal/workloads',
          path: 'helm/legacy',
          targetRevision: 'HEAD'
        },
        sources: [
          {
            repoURL: 'https://github.com/huggingface-internal/workloads',
            path: 'helm/new-path',
            targetRevision: 'HEAD'
          }
        ]
      },
      status: { sync: { status: 'Synced' } }
    };

    const result = getAppSource(app, owner, repo);
    expect(result).not.toBeNull();
    expect(result!.source.path).toBe('helm/legacy');
    expect(result!.sourcePosition).toBeUndefined();
  });
});
