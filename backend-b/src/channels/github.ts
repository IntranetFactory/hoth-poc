/**
 * GitHub channel — issues on the connected repo become agent conversations
 * (https://flueframework.com/docs/ecosystem/channels/github/).
 *
 * Ingress: the channel verifies X-Hub-Signature-256 against
 * GITHUB_WEBHOOK_SECRET over the raw delivery bytes before the handler runs,
 * so its /webhook route is mounted OUTSIDE the API-key guard in app.ts.
 * `issues.opened` and `issue_comment.created` dispatch to the `hoth` agent
 * keyed by the canonical conversation key (one conversation per issue), so
 * follow-up comments continue the same session.
 *
 * Egress: the agent posts replies through the comment_on_github_issue tool
 * (Octokit + GITHUB_TOKEN). Every reply carries AGENT_MARKER and the webhook
 * skips marked/bot comments — that is the loop guard: without it the agent's
 * own comment would re-trigger a dispatch forever.
 */
import { env } from 'cloudflare:workers';
import { createGitHubChannel, type GitHubIssueRef } from '@flue/github';
import { defineTool, dispatch } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';

const secrets = env as Record<string, string | undefined>;

/** Appended (as an invisible HTML comment) to every agent reply. */
const AGENT_MARKER = '<!-- hoth-agent-reply -->';

export const channel = createGitHubChannel({
  webhookSecret: secrets.GITHUB_WEBHOOK_SECRET ?? '',
  async webhook({ delivery }) {
    if (delivery.name === 'issues' && delivery.payload.action === 'opened') {
      const { repository, issue } = delivery.payload;
      await dispatchToHoth(
        { owner: repository.owner.login, repo: repository.name, issueNumber: issue.number },
        {
          type: 'github.issue.opened',
          deliveryId: delivery.deliveryId,
          issue: { number: issue.number, title: issue.title, body: issue.body ?? '', author: issue.user?.login ?? 'unknown' },
        },
      );
      return { status: 'dispatched' };
    }

    if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
      const { repository, issue, comment } = delivery.payload;
      // Loop guard: never re-dispatch the agent's own replies.
      if (comment.user?.type === 'Bot' || comment.body.includes(AGENT_MARKER)) {
        return { status: 'skipped: agent or bot comment' };
      }
      await dispatchToHoth(
        { owner: repository.owner.login, repo: repository.name, issueNumber: issue.number },
        {
          type: 'github.issue_comment.created',
          deliveryId: delivery.deliveryId,
          issue: { number: issue.number, title: issue.title },
          comment: { id: comment.id, body: comment.body, author: comment.user?.login ?? 'unknown' },
        },
      );
      return { status: 'dispatched' };
    }
  },
});

async function dispatchToHoth(ref: GitHubIssueRef, input: unknown): Promise<void> {
  await dispatch({ agent: 'hoth', id: channel.conversationKey(ref), input });
}

/** The GitHub issue bound to this agent instance, or null for non-GitHub sessions. */
export function gitHubRefFromConversation(id: string): GitHubIssueRef | null {
  try {
    return channel.parseConversationKey(id);
  } catch {
    return null;
  }
}

export function commentOnIssue(ref: GitHubIssueRef) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: `Post a Markdown comment as your answer on GitHub issue #${ref.issueNumber} in ${ref.owner}/${ref.repo}.`,
    input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
    async run({ input: { body } }) {
      const client = new Octokit({ auth: secrets.GITHUB_TOKEN });
      const result = await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body: `${body}\n\n${AGENT_MARKER}`,
      });
      return { commentId: result.data.id, url: result.data.html_url };
    },
  });
}
