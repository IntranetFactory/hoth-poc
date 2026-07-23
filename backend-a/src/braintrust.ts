// flue-blueprint: tooling/braintrust@2
import { type FlueEvent, observe } from '@flue/runtime';
import { braintrustFlueObserver, initLogger } from 'braintrust';

const apiKey = process.env.BRAINTRUST_API_KEY;
const observedRuns = new Set<string>();

if (apiKey) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
    apiKey,
  });

  observe((event, ctx) => {
    const compatible = compatibleEvent(event);
    if (compatible) braintrustFlueObserver(compatible, ctx);
  });
}

// Braintrust 3.17 still expects the pre-v2 `tool_call` terminal event name and
// doesn't know `run_resume`; translate both here instead of changing Flue's
// event contract. Re-check on every Braintrust upgrade and drop the
// translations once the SDK accepts current events directly.
//
// Additionally (2.0 nightlies past the @2 blueprint): turn events moved their
// payload under `request`/`response`, and an agent prompt's output rides in
// the `agentOutput` observation detail instead of the operation `result`.
// Braintrust 3.17 reads the old flat fields (`model`, `input`, `output`,
// `usage`, `stopReason`, `result`), so flatten them back or model spans lose
// content and token/cost metrics.
function compatibleEvent(event: FlueEvent): unknown {
  if (event.type === 'run_start') {
    observedRuns.add(event.runId);
    return event;
  }
  if (event.type === 'run_end') {
    observedRuns.delete(event.runId);
    return event;
  }
  if (event.type === 'tool') return { ...event, type: 'tool_call' };
  if (event.type === 'run_resume') {
    if (observedRuns.has(event.runId)) return event;
    observedRuns.add(event.runId);
    return { ...event, type: 'run_start', input: undefined, payload: undefined };
  }
  if (event.type === 'turn_request') {
    const { request } = event as { request?: TurnRequestInfo };
    return {
      ...event,
      model: request?.requestedModel,
      provider: request?.providerName ?? request?.providerId,
      api: request?.api,
      reasoning: request?.reasoningLevel,
      input: request?.input,
    };
  }
  if (event.type === 'turn') {
    const { request, response } = event as { request?: TurnRequestInfo; response?: TurnResponseInfo };
    return {
      ...event,
      model: response?.responseModel ?? request?.requestedModel,
      provider: request?.providerName ?? request?.providerId,
      api: request?.api,
      output: response?.output,
      usage: response?.usage,
      stopReason: response?.finishReason,
      error: (event as { error?: unknown }).error ?? response?.error,
    };
  }
  if (event.type === 'operation') {
    const { result, agentOutput } = event as { result?: unknown; agentOutput?: unknown };
    return result === undefined && agentOutput !== undefined ? { ...event, result: agentOutput } : event;
  }
  if (
    event.type === 'operation_start' ||
    event.type === 'tool_start' ||
    event.type === 'task_start' ||
    event.type === 'task' ||
    event.type === 'compaction_start' ||
    event.type === 'compaction'
  ) {
    return event;
  }
  return undefined;
}

type TurnRequestInfo = {
  providerId?: string;
  providerName?: string;
  requestedModel?: string;
  api?: string;
  reasoningLevel?: string;
  input?: unknown;
};

type TurnResponseInfo = {
  responseModel?: string;
  output?: unknown;
  usage?: unknown;
  finishReason?: string;
  error?: unknown;
};
