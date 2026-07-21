/**
 * Panel B of the Chats (A/B) tab: the same flue agent session as Panel A, but
 * rendered with Vercel ai-elements (shadcn/Radix) for a richer UX — markdown
 * tables, collapsible tool-call cards, streamed reasoning, auto-scroll, and a
 * real busy indicator.
 *
 * Data source is identical to Panel A's `Chat`: `useFlueAgent(... live:'sse')`
 * against the same agent Durable Object, so both panels still converge. flue's
 * `FlueConversationMessage` mirrors the AI SDK v5 `UIMessage` shape that
 * ai-elements consumes, so mapping is near 1:1 — only role/status need trivial
 * maps.
 */
import { useFlueAgent } from '@flue/react';
import type { FlueClient } from '@flue/sdk';
import type { ChatStatus } from 'ai';
import { MessageSquareIcon } from 'lucide-react';
import { useState } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';

type AgentMessage = ReturnType<typeof useFlueAgent>['messages'][number];
type AgentPart = AgentMessage['parts'][number];

/** flue AgentStatus → ai-elements ChatStatus (drives the submit-button icon). */
function toChatStatus(status: ReturnType<typeof useFlueAgent>['status']): ChatStatus {
  if (status === 'streaming') return 'streaming';
  if (status === 'submitted' || status === 'connecting') return 'submitted';
  if (status === 'error') return 'error';
  return 'ready';
}

export function AgentChat({ client, sessionId }: { client: FlueClient; sessionId: string }) {
  const [input, setInput] = useState('');
  // One held SSE stream (same as Panel A) — needs the @durable-streams/client patch.
  const agent = useFlueAgent({ name: 'hoth', id: sessionId, client, live: 'sse' });

  const chatStatus = toChatStatus(agent.status);
  // 'submitted' and 'streaming' both mean "generating". flue exposes no cancel,
  // so we never show PromptInputSubmit's default stop-square (it would imply a
  // click-to-cancel that does nothing) — a spinner honestly signals both.
  const busy = chatStatus === 'submitted' || chatStatus === 'streaming';

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if (!text) return;
    setInput('');
    void agent.sendMessage(text);
  }

  return (
    <TooltipProvider>
      <div className="mt-2 flex h-[60vh] flex-col overflow-hidden rounded-lg border bg-background text-foreground">
        <Conversation>
          <ConversationContent>
            {agent.messages.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquareIcon className="size-10" />}
                title="No messages yet"
                description="Send a message — it appears in Panel A too (same session)."
              />
            ) : (
              agent.messages.map((message) => <MessageView key={message.id} message={message} />)
            )}
            {/* Busy-before-first-token: shown while a submission is in flight. Once
                generation starts (status 'streaming'), the partial content / tool
                cards render instead, so this hides. */}
            {agent.status === 'submitted' ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner /> Working…
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t p-3">
          <PromptInput onSubmit={handleSubmit}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                placeholder='Try: "Plan me a spa day in the Echo Basin, Aug 1-3 2026"'
                onChange={(event) => setInput(event.currentTarget.value)}
              />
            </PromptInputBody>
            <PromptInputFooter>
              {/* No status text — the submit icon reflects agent.status via
                  toChatStatus: ready ↵ / generating ⟳ (spinner) / error ✕. */}
              <PromptInputSubmit
                status={chatStatus}
                disabled={!input.trim()}
                className="ml-auto"
                {...(busy ? { 'aria-label': 'Generating' } : {})}
              >
                {busy ? <Spinner /> : undefined}
              </PromptInputSubmit>
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </TooltipProvider>
  );
}

function MessageView({ message }: { message: AgentMessage }) {
  // Consolidate all reasoning parts into one block (a model may emit several) so
  // there's a single "Thinking…" affordance rather than one per part.
  const reasoningParts = message.parts.filter(
    (part): part is Extract<AgentPart, { type: 'reasoning' }> => part.type === 'reasoning',
  );
  const reasoningText = reasoningParts.map((part) => part.text).join('\n\n');
  const lastPart = message.parts.at(-1);
  const isReasoningStreaming = lastPart?.type === 'reasoning' && lastPart.state === 'streaming';

  return (
    <Message from={message.role}>
      <MessageContent>
        {reasoningParts.length > 0 ? (
          <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
            <ReasoningTrigger />
            <ReasoningContent>{reasoningText}</ReasoningContent>
          </Reasoning>
        ) : null}
        {message.parts.map((part, index) => (
          <PartView key={index} part={part} />
        ))}
      </MessageContent>
    </Message>
  );
}

function PartView({ part }: { part: AgentPart }) {
  switch (part.type) {
    case 'text':
      return <MessageResponse>{part.text}</MessageResponse>;
    case 'dynamic-tool':
      return (
        // Auto-open on error so the failure is visible without a click.
        <Tool defaultOpen={part.state === 'output-error'}>
          <ToolHeader type="dynamic-tool" toolName={part.toolName} state={part.state} />
          <ToolContent>
            <ToolInput input={part.input} />
            <ToolOutput
              output={part.state === 'output-available' ? part.output : undefined}
              errorText={part.state === 'output-error' ? part.errorText : undefined}
            />
          </ToolContent>
        </Tool>
      );
    case 'file':
      // Defensive — hoth likely emits no attachments. Render inline if present.
      if (!part.url) return null;
      return part.mediaType?.startsWith('image/') ? (
        <img src={part.url} alt={part.filename ?? ''} className="max-w-full rounded-md" />
      ) : (
        <a href={part.url} target="_blank" rel="noreferrer" className="text-primary underline">
          {part.filename ?? 'attachment'}
        </a>
      );
    default:
      // 'reasoning' is rendered in the consolidated block above.
      return null;
  }
}
